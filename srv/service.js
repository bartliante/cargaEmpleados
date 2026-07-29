import cds from "@sap/cds";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CONNECTIONS_FILE = join(import.meta.dirname, "../db/data/cargaempleados-SFSFConnections.csv");
const CONNECTIONS_COLUMNS = ["Instancia_SFSF", "URL_API", "Destination", "NombreSistemaSFSF"];
const CDSRC_PRIVATE_FILE = join(import.meta.dirname, "../.cdsrc-private.json");

// ---------------------------------------------------------------------
// Local (no BTP) storage: connections catalog in a CSV file, destination
// credentials in .cdsrc-private.json. Everything here is only used when
// no real BTP destination service is bound (see getDestinationServiceCredentials).
// ---------------------------------------------------------------------

/**
 * SFSFConnections isn't backed by a database - it's read from and appended
 * to this plain CSV file, so no database is required to run the app.
 */
function readConnectionsFromFile() {
	if (!existsSync(CONNECTIONS_FILE)) {
		return [];
	}

	const aLines = readFileSync(CONNECTIONS_FILE, "utf8")
		.split(/\r?\n/)
		.filter((sLine) => sLine.trim().length > 0);

	if (aLines.length === 0) {
		return [];
	}

	const aHeaders = aLines[0].split(",").map((s) => s.trim());
	return aLines.slice(1).map((sLine) => {
		const aValues = sLine.split(",");
		const oRow = {};
		aHeaders.forEach((sHeader, i) => {
			oRow[sHeader] = (aValues[i] || "").trim();
		});
		return oRow;
	});
}

function appendConnectionToFile(oConnection) {
	const aConnections = readConnectionsFromFile();
	aConnections.push(oConnection);

	const aLines = [CONNECTIONS_COLUMNS.join(",")];
	aConnections.forEach((oRow) => {
		aLines.push(CONNECTIONS_COLUMNS.map((sColumn) => oRow[sColumn] || "").join(","));
	});
	writeFileSync(CONNECTIONS_FILE, aLines.join("\n") + "\n", "utf8");
}

// In-memory overlay so a destination registered locally is usable
// immediately, without waiting for a server restart to reload
// .cdsrc-private.json into cds.env.
const oRuntimeLocalDestinations = {};

/** Best-effort persistence of a local destination's credentials for future restarts. */
function persistLocalDestination(sDestinationAlias, sUsuario, sPassword) {
	let oConfig = {};
	if (existsSync(CDSRC_PRIVATE_FILE)) {
		try {
			oConfig = JSON.parse(readFileSync(CDSRC_PRIVATE_FILE, "utf8"));
		} catch (e) {
			oConfig = {};
		}
	}
	oConfig.destinations = oConfig.destinations || {};
	oConfig.destinations[sDestinationAlias] = { username: sUsuario, password: sPassword };
	writeFileSync(CDSRC_PRIVATE_FILE, JSON.stringify(oConfig, null, "\t") + "\n", "utf8");
}

function registerLocalDestination(sDestinationAlias, sUsuario, sPassword) {
	oRuntimeLocalDestinations[sDestinationAlias] = { username: sUsuario, password: sPassword };
	persistLocalDestination(sDestinationAlias, sUsuario, sPassword);
}

// ---------------------------------------------------------------------
// BTP Destination service (production): raw REST calls using the
// credentials of a bound "destination" service instance. Not verified
// against a real subaccount - this environment has no BTP connectivity.
// ---------------------------------------------------------------------

/** Returns the bound Destination service instance's credentials, or null if not bound (e.g. local dev). */
function getDestinationServiceCredentials() {
	if (!process.env.VCAP_SERVICES) {
		return null;
	}

	let oVcapServices;
	try {
		oVcapServices = JSON.parse(process.env.VCAP_SERVICES);
	} catch (e) {
		return null;
	}

	const aInstances = oVcapServices.destination;
	return aInstances && aInstances.length > 0 ? aInstances[0].credentials : null;
}

async function getDestinationServiceToken(oServiceCredentials) {
	const oResponse = await fetch(`${oServiceCredentials.url}/oauth/token?grant_type=client_credentials`, {
		method: "POST",
		headers: {
			Authorization: "Basic " + Buffer.from(`${oServiceCredentials.clientid}:${oServiceCredentials.clientsecret}`).toString("base64")
		}
	});
	if (!oResponse.ok) {
		throw new Error(`No se ha podido autenticar con el Destination Service (HTTP ${oResponse.status})`);
	}
	const oToken = await oResponse.json();
	return oToken.access_token;
}

/** Lists subaccount destinations tagged as SFSF connections (custom "sfsfInstancia" property). */
async function readConnectionsFromBtp(oServiceCredentials) {
	const sToken = await getDestinationServiceToken(oServiceCredentials);
	const oResponse = await fetch(`${oServiceCredentials.uri}/destination-configuration/v1/subaccountDestinations`, {
		headers: { Authorization: `Bearer ${sToken}` }
	});
	if (!oResponse.ok) {
		throw new Error(`No se han podido listar los Destinations de BTP (HTTP ${oResponse.status})`);
	}

	const aDestinations = await oResponse.json();
	return aDestinations
		.filter((oDestination) => oDestination.sfsfInstancia)
		.map((oDestination) => ({
			Instancia_SFSF: oDestination.sfsfInstancia,
			URL_API: oDestination.URL || "",
			Destination: oDestination.Name,
			NombreSistemaSFSF: oDestination.sfsfSystemName || ""
		}));
}

/** Creates a BasicAuthentication destination in BTP, tagged so it's picked up by readConnectionsFromBtp. */
async function createBtpDestination(oServiceCredentials, sDestinationAlias, oConnection, sUsuario, sPassword) {
	const sToken = await getDestinationServiceToken(oServiceCredentials);
	const oResponse = await fetch(`${oServiceCredentials.uri}/destination-configuration/v1/subaccountDestinations`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${sToken}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			Name: sDestinationAlias,
			Type: "HTTP",
			URL: oConnection.URL_API,
			Authentication: "BasicAuthentication",
			ProxyType: "Internet",
			User: sUsuario,
			Password: sPassword,
			sfsfInstancia: oConnection.Instancia_SFSF,
			sfsfSystemName: oConnection.NombreSistemaSFSF || ""
		})
	});
	if (!oResponse.ok) {
		const sBody = await oResponse.text();
		throw new Error(`No se ha podido crear el Destination en BTP (HTTP ${oResponse.status}): ${sBody}`);
	}
}

/** Resolves a destination alias to its Basic Auth credentials, from BTP if bound, else from local config. */
async function resolveDestinationCredentials(sDestinationAlias) {
	const oServiceCredentials = getDestinationServiceCredentials();

	if (oServiceCredentials) {
		const sToken = await getDestinationServiceToken(oServiceCredentials);
		const oResponse = await fetch(
			`${oServiceCredentials.uri}/destination-configuration/v1/destinations/${encodeURIComponent(sDestinationAlias)}`,
			{ headers: { Authorization: `Bearer ${sToken}` } }
		);
		if (!oResponse.ok) {
			return null;
		}
		const oResolved = await oResponse.json();
		const oDestination = oResolved.destinationConfiguration || oResolved;
		if (!oDestination.User || !oDestination.Password) {
			return null;
		}
		return { user: oDestination.User, password: oDestination.Password };
	}

	const oLocal = oRuntimeLocalDestinations[sDestinationAlias] || (cds.env.destinations || {})[sDestinationAlias];
	if (!oLocal || !oLocal.username || !oLocal.password) {
		return null;
	}
	return { user: oLocal.username, password: oLocal.password };
}

class HttpError extends Error {
	constructor(iStatus, sMessage) {
		super(sMessage);
		this.status = iStatus;
	}
}

/** Resolves a connection alias to its SFSFConnections row + Basic Auth credentials, or throws an HttpError. */
async function resolveConnectionAndCredentials(sConnection) {
	const oDestServiceCreds = getDestinationServiceCredentials();
	const aConnections = oDestServiceCreds ? await readConnectionsFromBtp(oDestServiceCreds) : readConnectionsFromFile();
	const oConnection = aConnections.find((c) => c.Instancia_SFSF === sConnection);
	if (!oConnection) {
		throw new HttpError(400, `No existe la conexión SFSF "${sConnection}"`);
	}
	if (!oConnection.Destination) {
		throw new HttpError(500, `La conexión SFSF "${sConnection}" no tiene Destination configurado`);
	}

	const oCredentials = await resolveDestinationCredentials(oConnection.Destination);
	if (!oCredentials) {
		throw new HttpError(
			500,
			`No se ha podido resolver el destino "${oConnection.Destination}" (revisa "destinations" en .cdsrc-private.json en local, o el Destination service en BTP)`
		);
	}

	return { oConnection, oCredentials };
}

let iBatchCounter = 0;

/**
 * Splits "Entity.field" keys into a nested { Entity: { field: value } }
 * structure - the shape the real SFSF OData push will need per entity.
 */
function groupFieldsByEntity(oFields) {
	const oGrouped = {};

	Object.keys(oFields || {}).forEach((sHeader) => {
		const iDot = sHeader.indexOf(".");
		const sEntity = iDot === -1 ? "_" : sHeader.substring(0, iDot);
		const sField = iDot === -1 ? sHeader : sHeader.substring(iDot + 1);

		if (!oGrouped[sEntity]) {
			oGrouped[sEntity] = {};
		}
		oGrouped[sEntity][sField] = oFields[sHeader];
	});

	return oGrouped;
}

/**
 * An entity is only included in the batch if its first field (the one that
 * would identify the record, e.g. userId/personIdExternal) has a value.
 */
function hasFirstFieldValue(oEntityFields) {
	const sFirstField = Object.keys(oEntityFields)[0];
	const vFirstValue = oEntityFields[sFirstField];
	return vFirstValue !== undefined && vFirstValue !== null && vFirstValue !== "";
}

function escapeXml(vValue) {
	return String(vValue)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A plain "yyyy-mm-dd" value is sent to SFSF as "yyyy-mm-ddT00:00:00". */
function formatFieldValue(vValue) {
	if (typeof vValue === "string" && DATE_ONLY_PATTERN.test(vValue)) {
		return `${vValue}T00:00:00`;
	}
	return vValue;
}

/**
 * Builds the atom+xml <entry> for one entity's upsert. Every field
 * (including what would be a key field, e.g. userId/personIdExternal) is
 * sent as an <m:properties> child - <id> only carries the entity name.
 */
function buildEntityXml(sEntity, oEntityFields) {
	const sProperties = Object.keys(oEntityFields)
		.map((sField) => `      <d:${sField}>${escapeXml(formatFieldValue(oEntityFields[sField]))}</d:${sField}>`)
		.join("\n");

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<entry xmlns="http://www.w3.org/2005/Atom"',
		'       xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"',
		'       xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">',
		`  <id>${sEntity}</id>`,
		'  <content type="application/xml">',
		"    <m:properties>",
		sProperties,
		"    </m:properties>",
		"  </content>",
		"</entry>"
	].join("\n");
}

/** Deterministic non-negative numeric hash of a string (djb2-style, 32-bit unsigned). */
function numericHash(sInput) {
	let iHash = 0;
	for (let i = 0; i < sInput.length; i++) {
		iHash = (iHash * 31 + sInput.charCodeAt(i)) >>> 0;
	}
	return iHash;
}

/**
 * PaymentInformationDetailV3 needs a numeric externalCode. When the CSV
 * doesn't provide one, it's derived from a hash of worker + effectiveStartDate
 * + payType, so the same combination always yields the same externalCode.
 */
function ensurePaymentInformationExternalCode(oEntityFields) {
	if (oEntityFields.externalCode !== undefined && oEntityFields.externalCode !== null && oEntityFields.externalCode !== "") {
		return oEntityFields;
	}

	const sSeed = [
		oEntityFields.PaymentInformationV3_worker || "",
		oEntityFields.PaymentInformationV3_effectiveStartDate || "",
		oEntityFields.payType || ""
	].join("|");

	return { ...oEntityFields, externalCode: numericHash(sSeed) };
}

const PRIMARY_GROUP_KEY_FIELDS = ["personIdExternal", "worker", "PaymentInformationV3_worker"];
const FALLBACK_GROUP_KEY_FIELDS = ["userId"];

/** Finds the value of the first "Entity.field" whose field part matches one of aFieldNames. */
function findFieldValue(oFields, aFieldNames) {
	for (const sHeader of Object.keys(oFields)) {
		const iDot = sHeader.indexOf(".");
		const sField = iDot === -1 ? sHeader : sHeader.substring(iDot + 1);
		const vValue = oFields[sHeader];

		if (aFieldNames.includes(sField) && vValue !== undefined && vValue !== null && vValue !== "") {
			return vValue;
		}
	}
	return null;
}

/**
 * The employee identifier for a row: personIdExternal/worker/
 * PaymentInformationV3_worker (whichever is present), falling back to
 * userId. Returns null if none of them is present.
 */
function getGroupKey(oRow) {
	const vPrimary = findFieldValue(oRow.fields, PRIMARY_GROUP_KEY_FIELDS);
	return vPrimary !== null ? vPrimary : findFieldValue(oRow.fields, FALLBACK_GROUP_KEY_FIELDS);
}

/**
 * Groups rows into batches by employee identifier: rows whose group key
 * (see getGroupKey) matches go into the same batch, regardless of the order
 * they appear in. A row with no identifiable key value gets its own group.
 */
function groupRowsIntoBatches(aRows) {
	const aBatches = [];
	const oBatchByKey = {};

	aRows.forEach((oRow) => {
		const vKey = getGroupKey(oRow);

		if (vKey === null) {
			aBatches.push([oRow]);
			return;
		}

		const sKey = String(vKey);
		if (oBatchByKey[sKey]) {
			oBatchByKey[sKey].push(oRow);
		} else {
			const aNewBatch = [oRow];
			oBatchByKey[sKey] = aNewBatch;
			aBatches.push(aNewBatch);
		}
	});

	return aBatches;
}

/**
 * Builds the multipart/mixed $batch body SFSF expects for batch execution:
 * a single outer "batch_<n>" wrapping one "changeset_<n>" changeset, with
 * one atom+xml "POST upsert" part per entity across all given records.
 * Returns both the body text and the boundary, since the boundary is also
 * needed for the Content-Type header when the batch is sent.
 */
function buildBatchBody(aRows) {
	iBatchCounter++;
	const sBatchBoundary = `batch_${iBatchCounter}`;
	const sChangesetBoundary = `changeset_${iBatchCounter}`;

	const aLines = [
		`--${sBatchBoundary}`,
		`Content-Type: multipart/mixed; boundary=${sChangesetBoundary}`,
		""
	];

	aRows.forEach((oRow) => {
		const oByEntity = groupFieldsByEntity(oRow.fields);
		Object.keys(oByEntity).forEach((sEntity) => {
			if (!hasFirstFieldValue(oByEntity[sEntity])) {
				return;
			}

			const oEntityFields = sEntity === "PaymentInformationDetailV3"
				? ensurePaymentInformationExternalCode(oByEntity[sEntity])
				: oByEntity[sEntity];

			aLines.push(
				`--${sChangesetBoundary}`,
				"Content-Type: application/http",
				"Content-Transfer-Encoding: binary",
				"",
				"POST upsert HTTP/1.1",
				"Content-Type: application/atom+xml",
				"Accept: application/atom+xml",
				"",
				buildEntityXml(sEntity, oEntityFields),
				""
			);
		});
	});

	aLines.push(`--${sChangesetBoundary}--`, `--${sBatchBoundary}--`);

	return { boundary: sBatchBoundary, body: aLines.join("\n") };
}

// ---------------------------------------------------------------------
// Non-batch (batchMode = false) execution: unlike batch mode (grouped by
// employee), records are grouped by SFSF entity type across all selected
// rows, then each entity's records are chunked by recordsPerEntity - never
// splitting a single employee's records for that entity across chunks.
// ---------------------------------------------------------------------

/**
 * Groups every selected row's entity data by entity type (not by employee):
 * one array per entity name, each record carrying the employee key it
 * belongs to (for chunk boundaries and per-row result aggregation) and its
 * original rowIndex.
 */
function groupRecordsByEntityType(aRows) {
	const oByEntityType = {};

	aRows.forEach((oRow, i) => {
		const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
		const sEmployeeKey = String(getGroupKey(oRow) ?? `__row${iRowIndex}`);
		const oByEntity = groupFieldsByEntity(oRow.fields);

		Object.keys(oByEntity).forEach((sEntity) => {
			if (!hasFirstFieldValue(oByEntity[sEntity])) {
				return;
			}

			if (!oByEntityType[sEntity]) {
				oByEntityType[sEntity] = [];
			}
			oByEntityType[sEntity].push({
				rowIndex: iRowIndex,
				employeeKey: sEmployeeKey,
				fields: sEntity === "PaymentInformationDetailV3" ? ensurePaymentInformationExternalCode(oByEntity[sEntity]) : oByEntity[sEntity]
			});
		});
	});

	return oByEntityType;
}

/** Groups records by employeeKey, keeping each employee's records contiguous in first-appearance order. */
function groupByEmployeeKeyPreservingOrder(aRecords) {
	const oGroups = {};
	const aOrder = [];

	aRecords.forEach((oRecord) => {
		if (!oGroups[oRecord.employeeKey]) {
			oGroups[oRecord.employeeKey] = [];
			aOrder.push(oRecord.employeeKey);
		}
		oGroups[oRecord.employeeKey].push(oRecord);
	});

	return aOrder.map((sKey) => oGroups[sKey]);
}

/**
 * Splits an entity's records into chunks of ~iChunkSize records: whole
 * employee-groups are added to the current chunk until it reaches
 * iChunkSize, so a chunk can end up larger than iChunkSize when an
 * employee's own records for that entity don't fit evenly.
 */
function chunkByEmployee(aRecords, iChunkSize) {
	const aEmployeeGroups = groupByEmployeeKeyPreservingOrder(aRecords);
	const aChunks = [];
	let aCurrentChunk = [];

	aEmployeeGroups.forEach((aEmployeeRecords) => {
		aCurrentChunk.push(...aEmployeeRecords);
		if (aCurrentChunk.length >= iChunkSize) {
			aChunks.push(aCurrentChunk);
			aCurrentChunk = [];
		}
	});

	if (aCurrentChunk.length > 0) {
		aChunks.push(aCurrentChunk);
	}

	return aChunks;
}

/**
 * The "POST upsert ... HTTP/1.1" line for an entity: User gets
 * processInactiveEmployees=true; every other entity gets purgeType=full
 * when purge mode is on, or no query param at all otherwise.
 */
function buildUpsertLine(sEntity, bPurgeMode) {
	if (sEntity === "User") {
		return "POST upsert?processInactiveEmployees=true HTTP/1.1";
	}
	return bPurgeMode ? "POST upsert?purgeType=full HTTP/1.1" : "POST upsert HTTP/1.1";
}

/**
 * Splits a chunk's records into the units that become independent
 * changesets. With purge mode on, one changeset per employee - their
 * records for this entity succeed/fail together, matching purge's
 * all-or-nothing replace semantics. Otherwise, one changeset per
 * individual record, so one record's failure never rolls back another.
 */
function groupRecordsIntoChangesets(aChunkRecords, bPurgeMode) {
	if (bPurgeMode) {
		return groupByEmployeeKeyPreservingOrder(aChunkRecords);
	}
	return aChunkRecords.map((oRecord) => [oRecord]);
}

/**
 * Same overall multipart shape as buildBatchBody, but for one entity's
 * chunk of records, split into changesets by groupRecordsIntoChangesets.
 * A changeset is atomic in OData v2, so bundling records into fewer,
 * larger changesets means their outcomes ride together, while more/smaller
 * changesets keep them independent.
 * Also returns, per changeset and in order, the rowIndexes it covers, so
 * the response (which preserves changeset order) can be matched back to
 * the right rows - a changeset's outcome applies to all of its rowIndexes.
 */
function buildEntityChunkBody(sEntity, aChunkRecords, bPurgeMode) {
	iBatchCounter++;
	const sBatchBoundary = `batch_${iBatchCounter}`;
	const sUpsertLine = buildUpsertLine(sEntity, bPurgeMode);
	const aChangesetGroups = groupRecordsIntoChangesets(aChunkRecords, bPurgeMode);

	const aLines = [];

	aChangesetGroups.forEach((aGroupRecords, i) => {
		const sChangesetBoundary = `changeset_${iBatchCounter}_${i + 1}`;

		aLines.push(`--${sBatchBoundary}`, `Content-Type: multipart/mixed; boundary=${sChangesetBoundary}`, "");

		aGroupRecords.forEach((oRecord) => {
			aLines.push(
				`--${sChangesetBoundary}`,
				"Content-Type: application/http",
				"Content-Transfer-Encoding: binary",
				"",
				sUpsertLine,
				"Content-Type: application/atom+xml",
				"Accept: application/atom+xml",
				"",
				buildEntityXml(sEntity, oRecord.fields),
				""
			);
		});

		aLines.push(`--${sChangesetBoundary}--`);
	});

	aLines.push(`--${sBatchBoundary}--`);

	return {
		boundary: sBatchBoundary,
		body: aLines.join("\n"),
		changesetRowIndexes: aChangesetGroups.map((aGroupRecords) => aGroupRecords.map((oRecord) => oRecord.rowIndex))
	};
}

/**
 * POSTs one $batch document to SFSF and returns its outcome. A changeset is
 * atomic, so a single success/failure applies to every row in the group.
 */
async function sendBatchToSfsf(sUrlApi, oCredentials, sBoundary, sBody) {
	let oResponse;
	try {
		oResponse = await fetch(`${sUrlApi}/$batch`, {
			method: "POST",
			headers: {
				"Content-Type": `multipart/mixed; boundary=${sBoundary}`,
				Accept: "multipart/mixed",
				Authorization: "Basic " + Buffer.from(`${oCredentials.user}:${oCredentials.password}`).toString("base64")
			},
			body: sBody
		});
	} catch (oNetworkError) {
		return { success: false, errorMessage: `No se ha podido contactar con SFSF: ${oNetworkError.message}` };
	}

	const sResponseText = await oResponse.text();

	if (!oResponse.ok) {
		return { success: false, errorMessage: extractErrorMessage(sResponseText) || `SFSF respondió HTTP ${oResponse.status}` };
	}

	// A 2xx on the outer $batch call doesn't guarantee the changeset inside
	// succeeded - look for the embedded HTTP status of the changeset itself.
	const oInnerStatus = sResponseText.match(/HTTP\/1\.\d\s+(\d{3})/);
	const iInnerStatus = oInnerStatus ? parseInt(oInnerStatus[1], 10) : oResponse.status;

	if (iInnerStatus >= 300) {
		return { success: false, errorMessage: extractErrorMessage(sResponseText) || `SFSF respondió HTTP ${iInnerStatus}` };
	}

	return { success: true, errorMessage: "" };
}

/** Boundary declared in a response's Content-Type header, if any. */
function getResponseBoundary(oResponse) {
	const sContentType = oResponse.headers.get("content-type") || "";
	const oMatch = sContentType.match(/boundary=([^;]+)/);
	return oMatch ? oMatch[1].trim().replace(/^"|"$/g, "") : null;
}

/** Splits a multipart body into its top-level parts (in order) using the given boundary. */
function splitMultipartParts(sBody, sBoundary) {
	return sBody
		.split(`--${sBoundary}`)
		.slice(1, -1)
		.map((sPart) => sPart.trim())
		.filter((sPart) => sPart.length > 0);
}

function parseEmbeddedHttpStatus(sPart) {
	const oMatch = sPart.match(/HTTP\/1\.\d\s+(\d{3})/);
	return oMatch ? parseInt(oMatch[1], 10) : null;
}

/**
 * POSTs a $batch body built by buildEntityChunkBody and returns one outcome
 * per rowIndex (expanding each changeset's outcome to every rowIndex it
 * covers - see aChangesetRowIndexes), in the same order the changesets
 * were sent. A successful changeset's response part is itself a nested
 * multipart/mixed, while a failed one is a flat application/http part with
 * the error, so counting top-level response parts lets each be matched
 * back to its changeset by position.
 */
async function sendMultiChangesetToSfsf(sUrlApi, oCredentials, sBoundary, sBody, aChangesetRowIndexes) {
	const expand = (fnOutcomeForChangeset) => {
		const aResults = [];
		aChangesetRowIndexes.forEach((aRowIndexes, iChangesetIndex) => {
			const oOutcome = fnOutcomeForChangeset(iChangesetIndex);
			aRowIndexes.forEach((iRowIndex) => {
				aResults.push({ rowIndex: iRowIndex, success: oOutcome.success, errorMessage: oOutcome.errorMessage });
			});
		});
		return aResults;
	};

	let oResponse;
	try {
		oResponse = await fetch(`${sUrlApi}/$batch`, {
			method: "POST",
			headers: {
				"Content-Type": `multipart/mixed; boundary=${sBoundary}`,
				Accept: "multipart/mixed",
				Authorization: "Basic " + Buffer.from(`${oCredentials.user}:${oCredentials.password}`).toString("base64")
			},
			body: sBody
		});
	} catch (oNetworkError) {
		const sMessage = `No se ha podido contactar con SFSF: ${oNetworkError.message}`;
		return expand(() => ({ success: false, errorMessage: sMessage }));
	}

	const sResponseText = await oResponse.text();
	console.log(`sendMultiChangesetToSfsf: HTTP ${oResponse.status}\n${sResponseText}`);

	if (!oResponse.ok) {
		const sMessage = extractErrorMessage(sResponseText) || `SFSF respondió HTTP ${oResponse.status}`;
		return expand(() => ({ success: false, errorMessage: sMessage }));
	}

	const sResponseBoundary = getResponseBoundary(oResponse);
	const aParts = sResponseBoundary ? splitMultipartParts(sResponseText, sResponseBoundary) : [];

	if (aParts.length !== aChangesetRowIndexes.length) {
		// Response shape didn't match what we expected - fall back to a single
		// overall outcome for the whole chunk rather than guessing per changeset.
		console.log(`sendMultiChangesetToSfsf: se esperaban ${aChangesetRowIndexes.length} partes y se encontraron ${aParts.length}`);
		const iStatus = parseEmbeddedHttpStatus(sResponseText);
		const bSuccess = iStatus !== null && iStatus < 300;
		const sMessage = bSuccess ? "" : extractErrorMessage(sResponseText) || `SFSF respondió HTTP ${iStatus ?? oResponse.status}`;
		return expand(() => ({ success: bSuccess, errorMessage: sMessage }));
	}

	return expand((i) => {
		const iStatus = parseEmbeddedHttpStatus(aParts[i]);
		const bSuccess = iStatus !== null && iStatus < 300;
		return {
			success: bSuccess,
			errorMessage: bSuccess ? "" : extractErrorMessage(aParts[i]) || `SFSF respondió HTTP ${iStatus}`
		};
	});
}

/** Best-effort extraction of a human-readable error out of an OData v2 error body (XML or JSON). */
function extractErrorMessage(sResponseText) {
	const oXmlMatch = sResponseText.match(/<message[^>]*>([\s\S]*?)<\/message>/);
	if (oXmlMatch) {
		return oXmlMatch[1].trim();
	}

	const oJsonMatch = sResponseText.match(/"message"\s*:\s*\{[^}]*"value"\s*:\s*"([^"]+)"/);
	if (oJsonMatch) {
		return oJsonMatch[1];
	}

	return "";
}

// ---------------------------------------------------------------------
// SFSF $metadata inspection, for enriching the AI error analysis: given a
// failing entity/field, tells whether it's a picklist (sap:picklist
// attribute on the <Property>) or a navigation to another object (a sibling
// <NavigationProperty Name="{field}Nav"> whose Association points to a real
// entity, not a picklist option). Regex-based like the rest of this file's
// XML handling (extractErrorMessage) - $metadata is tens of MB, too big to
// justify pulling in a full XML parser dependency for this.
// ---------------------------------------------------------------------

const oMetadataCache = new Map(); // URL_API -> raw $metadata XML text, cached for the process lifetime

/** Fetches (and caches) the raw OData v2 $metadata document for a connection. */
async function fetchSfsfMetadata(sUrlApi, oCredentials) {
	if (oMetadataCache.has(sUrlApi)) {
		return oMetadataCache.get(sUrlApi);
	}

	const oResponse = await fetch(`${sUrlApi}/$metadata`, {
		headers: { Authorization: "Basic " + Buffer.from(`${oCredentials.user}:${oCredentials.password}`).toString("base64") }
	});
	if (!oResponse.ok) {
		throw new Error(`SFSF respondió HTTP ${oResponse.status} al consultar $metadata`);
	}

	const sMetadata = await oResponse.text();
	oMetadataCache.set(sUrlApi, sMetadata);
	return sMetadata;
}

function extractXmlAttr(sTag, sAttr) {
	const oMatch = sTag.match(new RegExp(`${sAttr}="([^"]*)"`));
	return oMatch ? oMatch[1] : null;
}

/** Strips a "Namespace.Name" qualifier down to just "Name" (associations/types are always namespace-qualified in $metadata). */
function stripNamespace(sQualifiedName) {
	const iDot = sQualifiedName.lastIndexOf(".");
	return iDot === -1 ? sQualifiedName : sQualifiedName.substring(iDot + 1);
}

function findEntityTypeBlock(sMetadata, sEntityName) {
	const oMatch = sMetadata.match(new RegExp(`<EntityType Name="${sEntityName}"[^>]*>[\\s\\S]*?</EntityType>`));
	return oMatch ? oMatch[0] : null;
}

function findPropertyTag(sEntityTypeBlock, sFieldName) {
	const oMatch = sEntityTypeBlock.match(new RegExp(`<Property Name="${sFieldName}"[^>]*>`));
	return oMatch ? oMatch[0] : null;
}

function findNavigationTag(sEntityTypeBlock, sNavName) {
	const oMatch = sEntityTypeBlock.match(new RegExp(`<NavigationProperty Name="${sNavName}"[^>]*>`));
	return oMatch ? oMatch[0] : null;
}

function findEntityKeyProperties(sEntityTypeBlock) {
	const oKeyMatch = sEntityTypeBlock.match(/<Key>([\s\S]*?)<\/Key>/);
	if (!oKeyMatch) {
		return [];
	}
	const aRefs = oKeyMatch[1].match(/<PropertyRef Name="([^"]+)"/g) || [];
	return aRefs.map((sRef) => sRef.match(/Name="([^"]+)"/)[1]);
}

function findAssociationTargetEntity(sMetadata, sRelationship, sToRole) {
	const sAssociationName = stripNamespace(sRelationship);
	const oAssocMatch = sMetadata.match(new RegExp(`<Association Name="${sAssociationName}"[^>]*>[\\s\\S]*?</Association>`));
	if (!oAssocMatch) {
		return null;
	}

	const aEnds = oAssocMatch[0].match(/<End[^>]*>/g) || [];
	const sEndTag = aEnds.find((sEnd) => extractXmlAttr(sEnd, "Role") === sToRole);
	const sType = sEndTag && extractXmlAttr(sEndTag, "Type");
	return sType ? stripNamespace(sType) : null;
}

/**
 * Classifies one entity's field from $metadata: "picklist" (with its
 * picklistId) if the <Property> carries sap:picklist, "navigation" (with the
 * related entity name and its key properties) if there's a "{field}Nav"
 * NavigationProperty pointing to a real entity (not a picklist option), or
 * null if neither applies.
 */
function classifyField(sMetadata, sEntityName, sFieldName) {
	const sEntityBlock = findEntityTypeBlock(sMetadata, sEntityName);
	if (!sEntityBlock) {
		return null;
	}

	const sPropertyTag = findPropertyTag(sEntityBlock, sFieldName);
	const sPicklistId = sPropertyTag && extractXmlAttr(sPropertyTag, "sap:picklist");
	if (sPicklistId) {
		return { type: "picklist", picklistId: sPicklistId };
	}

	const sNavTag = findNavigationTag(sEntityBlock, `${sFieldName}Nav`);
	if (!sNavTag) {
		return null;
	}

	const sToRole = extractXmlAttr(sNavTag, "ToRole");
	const sRelationship = extractXmlAttr(sNavTag, "Relationship");
	if (!sToRole || !sRelationship || sToRole === "picklistoption") {
		return null;
	}

	const sTargetEntity = findAssociationTargetEntity(sMetadata, sRelationship, sToRole);
	if (!sTargetEntity) {
		return null;
	}

	const sTargetEntityBlock = findEntityTypeBlock(sMetadata, sTargetEntity);
	const aKeyProperties = sTargetEntityBlock ? findEntityKeyProperties(sTargetEntityBlock) : [];

	return { type: "navigation", targetEntity: sTargetEntity, keyProperties: aKeyProperties };
}

/** Queries the configured values of a picklist, so the user can see valid options without opening SFSF. */
async function fetchPicklistOptions(sUrlApi, oCredentials, sPicklistId) {
	const sUrl = `${sUrlApi}/Picklist('${encodeURIComponent(sPicklistId)}')/picklistOptions?$select=id,externalCode,localeLabel,status&$format=json`;
	const oResponse = await fetch(sUrl, {
		headers: { Authorization: "Basic " + Buffer.from(`${oCredentials.user}:${oCredentials.password}`).toString("base64") }
	});
	if (!oResponse.ok) {
		return null;
	}
	const oBody = await oResponse.json();
	return (oBody.d?.results || []).map((oOption) => ({
		optionId: oOption.id,
		externalCode: oOption.externalCode,
		label: oOption.localeLabel,
		status: oOption.status
	}));
}

/** Queries the related object a navigation field points to, by filtering on its first key property. */
async function fetchNavigationTarget(sUrlApi, oCredentials, sTargetEntity, aKeyProperties, vValue) {
	if (aKeyProperties.length === 0 || vValue === undefined || vValue === null || vValue === "") {
		return null;
	}

	const sKeyProperty = aKeyProperties[0];
	const sFilterValue = String(vValue).replace(/'/g, "''");
	const sUrl = `${sUrlApi}/${sTargetEntity}?$filter=${encodeURIComponent(`${sKeyProperty} eq '${sFilterValue}'`)}&$format=json&$top=5`;

	const oResponse = await fetch(sUrl, {
		headers: { Authorization: "Basic " + Buffer.from(`${oCredentials.user}:${oCredentials.password}`).toString("base64") }
	});
	if (!oResponse.ok) {
		return null;
	}
	const oBody = await oResponse.json();
	return (oBody.d?.results || []).map(({ __metadata, ...oRest }) => oRest);
}

/**
 * Non-batch mode's replicationError is "Entity1: msg1 | Entity2: msg2" (see
 * processRecords), so the failing entity name(s) can be read straight off
 * it. Batch mode's error has no such attribution (one message for the whole
 * changeset) - returns [] in that case, and the caller falls back to
 * enriching every entity present in the row instead of guessing.
 */
function parseFailedEntityNames(sReplicationError) {
	const aEntities = [];
	(sReplicationError || "").split(" | ").forEach((sSegment) => {
		const oMatch = sSegment.match(/^(\w+):\s/);
		if (oMatch) {
			aEntities.push(oMatch[1]);
		}
	});
	return aEntities;
}

/**
 * Best-effort enrichment of a failed row's picklist/navigation fields from
 * SFSF's live $metadata and data, for the entities implicated by
 * replicationError (or every entity in the row, if that couldn't be
 * determined - see parseFailedEntityNames). Never throws - any SFSF call
 * failing here just means less context for the AI, not a failed analysis.
 */
async function buildFieldEnrichment(sUrlApi, oCredentials, oFields, sReplicationError) {
	const oByEntity = groupFieldsByEntity(oFields);
	const aFailedEntities = parseFailedEntityNames(sReplicationError);
	const aEntitiesToInspect = aFailedEntities.length > 0 ? aFailedEntities : Object.keys(oByEntity);

	let sMetadata;
	try {
		sMetadata = await fetchSfsfMetadata(sUrlApi, oCredentials);
	} catch (oError) {
		console.log(`buildFieldEnrichment: no se ha podido obtener $metadata: ${oError.message}`);
		return {};
	}

	const oEnrichment = {};

	for (const sEntity of aEntitiesToInspect) {
		const oEntityFields = oByEntity[sEntity];
		if (!oEntityFields) {
			continue;
		}

		for (const sField of Object.keys(oEntityFields)) {
			let oClassification;
			try {
				oClassification = classifyField(sMetadata, sEntity, sField);
			} catch (oError) {
				continue;
			}
			if (!oClassification) {
				continue;
			}

			try {
				if (oClassification.type === "picklist") {
					const aOptions = await fetchPicklistOptions(sUrlApi, oCredentials, oClassification.picklistId);
					if (aOptions) {
						oEnrichment[`${sEntity}.${sField}`] = { type: "picklist", picklistId: oClassification.picklistId, valoresConfigurados: aOptions };
					}
				} else if (oClassification.type === "navigation") {
					const aMatches = await fetchNavigationTarget(
						sUrlApi,
						oCredentials,
						oClassification.targetEntity,
						oClassification.keyProperties,
						oEntityFields[sField]
					);
					if (aMatches) {
						oEnrichment[`${sEntity}.${sField}`] = {
							type: "navigation",
							targetEntity: oClassification.targetEntity,
							valorBuscado: oEntityFields[sField],
							coincidencias: aMatches
						};
					}
				}
			} catch (oError) {
				console.log(`buildFieldEnrichment: fallo consultando ${sEntity}.${sField}: ${oError.message}`);
			}
		}
	}

	return oEnrichment;
}

const GEMINI_MODEL = "gemini-flash-latest";

/** Asks Gemini to explain an SFSF replication error and how to fix it, given the record's field values. */
async function analyzeErrorWithGemini(oFields, sReplicationError, oEnrichment) {
	const sApiKey = process.env.GEMINI_API_KEY;
	if (!sApiKey) {
		throw new Error("No se ha configurado GEMINI_API_KEY");
	}

	const aPromptLines = [
		"Eres un experto en SAP SuccessFactors (SFSF) y en la carga de datos de empleados vía OData.",
		"Se ha producido un error al replicar el siguiente registro hacia SFSF.",
		"",
		"Datos del registro (campo SFSF -> valor):",
		JSON.stringify(oFields, null, 2),
		"",
		"Mensaje de error devuelto por SFSF:",
		sReplicationError || "(sin mensaje de error)"
	];

	if (oEnrichment && Object.keys(oEnrichment).length > 0) {
		aPromptLines.push(
			"",
			"Información adicional consultada en tiempo real sobre los campos de tipo picklist o navegación de este registro",
			"(picklistId/valoresConfigurados = valores válidos configurados en SFSF para ese picklist;",
			"coincidencias = registros de la entidad relacionada cuyo identificador coincide con el valor enviado, vacío si no hay ninguno):",
			JSON.stringify(oEnrichment, null, 2)
		);
	}

	aPromptLines.push(
		"",
		"Explica en español, de forma breve y clara, la causa más probable del error y los pasos concretos que debe seguir el usuario para corregirlo antes de reintentar la carga.",
		"Si la información adicional anterior incluye valores configurados o coincidencias relevantes, apóyate en ellos (por ejemplo, indicando el valor correcto a usar) en lugar de dar una respuesta genérica.",
		"Al listar valores de un picklist, indica siempre para cada uno sus tres datos - optionId, externalCode y label -, no solo externalCode y label: el usuario los necesita para no tener que consultarlos manualmente en SFSF."
	);

	const sPrompt = aPromptLines.join("\n");

	let oResponse;
	try {
		oResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": sApiKey
			},
			body: JSON.stringify({ contents: [{ parts: [{ text: sPrompt }] }] })
		});
	} catch (oNetworkError) {
		throw new Error(`No se ha podido contactar con Gemini: ${oNetworkError.message}`);
	}

	if (!oResponse.ok) {
		const sBody = await oResponse.text();
		throw new Error(`Gemini respondió HTTP ${oResponse.status}: ${sBody}`);
	}

	const oResult = await oResponse.json();
	const aParts = oResult.candidates?.[0]?.content?.parts || [];
	const sText = aParts.map((oPart) => oPart.text || "").join("");

	if (!sText) {
		throw new Error("Gemini no ha devuelto ningún análisis");
	}
	return sText;
}

export default function () {
	this.on("READ", "SFSFConnections", async () => {
		const oServiceCredentials = getDestinationServiceCredentials();
		return oServiceCredentials ? readConnectionsFromBtp(oServiceCredentials) : readConnectionsFromFile();
	});

	this.on("registerConnection", async (req) => {
		const { Instancia_SFSF, URL_API, NombreSistemaSFSF, Usuario, Password } = req.data;

		if (!Instancia_SFSF || !Usuario || !Password) {
			return req.error(400, "Instancia_SFSF, Usuario y Password son obligatorios");
		}

		const oServiceCredentials = getDestinationServiceCredentials();
		const sDestinationAlias = `${Instancia_SFSF}-dest`;
		const oConnection = { Instancia_SFSF, URL_API, NombreSistemaSFSF };

		if (oServiceCredentials) {
			await createBtpDestination(oServiceCredentials, sDestinationAlias, oConnection, Usuario, Password);
		} else {
			const aExisting = readConnectionsFromFile();
			if (aExisting.some((oExisting) => oExisting.Instancia_SFSF === Instancia_SFSF)) {
				return req.error(400, `Ya existe una conexión con Instancia_SFSF "${Instancia_SFSF}"`);
			}
			registerLocalDestination(sDestinationAlias, Usuario, Password);
			appendConnectionToFile({
				Instancia_SFSF,
				URL_API: URL_API || "",
				Destination: sDestinationAlias,
				NombreSistemaSFSF: NombreSistemaSFSF || ""
			});
		}

		return {
			Instancia_SFSF,
			URL_API: URL_API || "",
			Destination: sDestinationAlias,
			NombreSistemaSFSF: NombreSistemaSFSF || ""
		};
	});

	this.on("processRecords", async (req) => {
		const { connection, batchMode, purgeMode, recordsPerEntity, recordsJson } = req.data;

		let aRows;
		try {
			aRows = JSON.parse(recordsJson || "[]");
		} catch (e) {
			return req.error(400, "recordsJson no es un JSON válido");
		}

		let oConnection, oCredentials;
		try {
			({ oConnection, oCredentials } = await resolveConnectionAndCredentials(connection));
		} catch (oError) {
			return req.error(oError.status || 500, oError.message);
		}

		if (batchMode) {
			// Rows are grouped so that a row without User data travels in the same
			// SFSF $batch as the preceding row that did have it. Each group is one
			// atomic changeset, so its send outcome applies to all of its rows.
			const aBatches = groupRowsIntoBatches(aRows);
			const aResults = [];

			for (const aBatchRows of aBatches) {
				const { boundary, body } = buildBatchBody(aBatchRows);
				console.log(
					`processRecords: enviando batch a SFSF (connection=${connection}, boundary=${boundary}, filas=${aBatchRows.length})\n${body}`
				);

				const oOutcome = await sendBatchToSfsf(oConnection.URL_API, oCredentials, boundary, body);

				aBatchRows.forEach((oRow, i) => {
					const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
					aResults.push({
						rowIndex: iRowIndex,
						status: oOutcome.success ? "OK" : "ERROR",
						replicationError: oOutcome.success ? "" : oOutcome.errorMessage
					});
				});
			}

			return aResults;
		}

		// Non-batch: records are grouped by entity type (not by employee), then
		// each entity's records are chunked by recordsPerEntity (never
		// splitting one employee's records for that entity across chunks -
		// a chunk can end up bigger than recordsPerEntity because of this).
		// Within a chunk, purge mode groups an employee's records into one
		// changeset (succeed/fail together); otherwise each record gets its
		// own changeset. A row's overall result is OK only if every entity it
		// contributed to succeeded.
		const iChunkSize = Math.max(parseInt(recordsPerEntity, 10) || 1, 1);
		const oByEntityType = groupRecordsByEntityType(aRows);
		const oEntityOutcomeByRow = {}; // rowIndex -> { entityName: { success, errorMessage } }

		for (const sEntity of Object.keys(oByEntityType)) {
			const aChunks = chunkByEmployee(oByEntityType[sEntity], iChunkSize);

			for (const aChunkRecords of aChunks) {
				const { boundary, body, changesetRowIndexes } = buildEntityChunkBody(sEntity, aChunkRecords, purgeMode);
				console.log(
					`processRecords: enviando upsert de ${sEntity} a SFSF (connection=${connection}, boundary=${boundary}, changesets=${changesetRowIndexes.length})\n${body}`
				);

				const aOutcomes = await sendMultiChangesetToSfsf(oConnection.URL_API, oCredentials, boundary, body, changesetRowIndexes);

				aOutcomes.forEach((oOutcome) => {
					if (!oEntityOutcomeByRow[oOutcome.rowIndex]) {
						oEntityOutcomeByRow[oOutcome.rowIndex] = {};
					}
					oEntityOutcomeByRow[oOutcome.rowIndex][sEntity] = {
						success: oOutcome.success,
						errorMessage: oOutcome.errorMessage
					};
				});
			}
		}

		return aRows.map((oRow, i) => {
			const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
			const oByEntity = groupFieldsByEntity(oRow.fields);
			const aRowEntities = Object.keys(oByEntity).filter((sEntity) => hasFirstFieldValue(oByEntity[sEntity]));
			const oOutcomes = oEntityOutcomeByRow[iRowIndex] || {};

			const aFailures = aRowEntities
				.filter((sEntity) => oOutcomes[sEntity] && !oOutcomes[sEntity].success)
				.map((sEntity) => `${sEntity}: ${oOutcomes[sEntity].errorMessage}`);

			return {
				rowIndex: iRowIndex,
				status: aFailures.length > 0 ? "ERROR" : "OK",
				replicationError: aFailures.join(" | ")
			};
		});
	});

	this.on("analyzeErrorWithAI", async (req) => {
		const { connection, fieldsJson, replicationError } = req.data;

		let oFields;
		try {
			oFields = JSON.parse(fieldsJson || "{}");
		} catch (e) {
			return req.error(400, "fieldsJson no es un JSON válido");
		}

		let oEnrichment = {};
		try {
			const { oConnection, oCredentials } = await resolveConnectionAndCredentials(connection);
			oEnrichment = await buildFieldEnrichment(oConnection.URL_API, oCredentials, oFields, replicationError);
		} catch (oError) {
			// Best-effort: if we can't resolve the connection or reach SFSF for
			// enrichment, still fall back to a plain AI-only analysis below.
			console.log(`analyzeErrorWithAI: no se ha podido enriquecer con datos de SFSF: ${oError.message}`);
		}

		try {
			const sAnalysis = await analyzeErrorWithGemini(oFields, replicationError, oEnrichment);
			return { analysis: sAnalysis };
		} catch (oError) {
			return req.error(500, `No se ha podido analizar el error con IA: ${oError.message}`);
		}
	});
}
