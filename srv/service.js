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

/** Same multipart/changeset shape as buildBatchBody, but for one entity's chunk of records. */
function buildEntityChunkBody(sEntity, aChunkRecords, bPurgeMode) {
	iBatchCounter++;
	const sBatchBoundary = `batch_${iBatchCounter}`;
	const sChangesetBoundary = `changeset_${iBatchCounter}`;
	const sUpsertLine = buildUpsertLine(sEntity, bPurgeMode);

	const aLines = [
		`--${sBatchBoundary}`,
		`Content-Type: multipart/mixed; boundary=${sChangesetBoundary}`,
		""
	];

	aChunkRecords.forEach((oRecord) => {
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

	aLines.push(`--${sChangesetBoundary}--`, `--${sBatchBoundary}--`);

	return { boundary: sBatchBoundary, body: aLines.join("\n") };
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

		const oDestServiceCreds = getDestinationServiceCredentials();
		const aConnections = oDestServiceCreds ? await readConnectionsFromBtp(oDestServiceCreds) : readConnectionsFromFile();
		const oConnection = aConnections.find((c) => c.Instancia_SFSF === connection);
		if (!oConnection) {
			return req.error(400, `No existe la conexión SFSF "${connection}"`);
		}

		if (!oConnection.Destination) {
			return req.error(500, `La conexión SFSF "${connection}" no tiene Destination configurado`);
		}

		const oCredentials = await resolveDestinationCredentials(oConnection.Destination);
		if (!oCredentials) {
			return req.error(
				500,
				`No se ha podido resolver el destino "${oConnection.Destination}" (revisa "destinations" en .cdsrc-private.json en local, o el Destination service en BTP)`
			);
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
		// each entity's records are chunked by recordsPerEntity. An employee's
		// overall result is OK only if every entity it contributed to succeeded.
		const iChunkSize = Math.max(parseInt(recordsPerEntity, 10) || 1, 1);
		const oByEntityType = groupRecordsByEntityType(aRows);
		const oEntityOutcomeByEmployee = {}; // employeeKey -> { entityName: { success, errorMessage } }

		for (const sEntity of Object.keys(oByEntityType)) {
			const aChunks = chunkByEmployee(oByEntityType[sEntity], iChunkSize);

			for (const aChunkRecords of aChunks) {
				const { boundary, body } = buildEntityChunkBody(sEntity, aChunkRecords, purgeMode);
				console.log(
					`processRecords: enviando upsert de ${sEntity} a SFSF (connection=${connection}, boundary=${boundary}, registros=${aChunkRecords.length})\n${body}`
				);

				const oOutcome = await sendBatchToSfsf(oConnection.URL_API, oCredentials, boundary, body);

				aChunkRecords.forEach((oRecord) => {
					if (!oEntityOutcomeByEmployee[oRecord.employeeKey]) {
						oEntityOutcomeByEmployee[oRecord.employeeKey] = {};
					}
					oEntityOutcomeByEmployee[oRecord.employeeKey][sEntity] = {
						success: oOutcome.success,
						errorMessage: oOutcome.errorMessage
					};
				});
			}
		}

		return aRows.map((oRow, i) => {
			const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
			const sEmployeeKey = String(getGroupKey(oRow) ?? `__row${iRowIndex}`);
			const oByEntity = groupFieldsByEntity(oRow.fields);
			const aRowEntities = Object.keys(oByEntity).filter((sEntity) => hasFirstFieldValue(oByEntity[sEntity]));
			const oOutcomes = oEntityOutcomeByEmployee[sEmployeeKey] || {};

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
}
