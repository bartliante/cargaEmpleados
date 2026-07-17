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

/**
 * Groups rows into batches: a row with User data starts a new group; rows
 * without User data are appended to the current group (the previous row
 * that did have User data), since they belong to the same employee. If the
 * very first row has no User data, it starts its own group since there is
 * no earlier group to attach it to.
 */
function groupRowsIntoBatches(aRows) {
	const aBatches = [];

	aRows.forEach((oRow) => {
		const oByEntity = groupFieldsByEntity(oRow.fields);
		const bHasUser = !!oByEntity.User && hasFirstFieldValue(oByEntity.User);
		const aCurrentBatch = aBatches[aBatches.length - 1];

		if (bHasUser || !aCurrentBatch) {
			aBatches.push([oRow]);
		} else {
			aCurrentBatch.push(oRow);
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

			aLines.push(
				`--${sChangesetBoundary}`,
				"Content-Type: application/http",
				"Content-Transfer-Encoding: binary",
				"",
				"POST upsert HTTP/1.1",
				"Content-Type: application/atom+xml",
				"Accept: application/atom+xml",
				"",
				buildEntityXml(sEntity, oByEntity[sEntity]),
				""
			);
		});
	});

	aLines.push(`--${sChangesetBoundary}--`, `--${sBatchBoundary}--`);

	return { boundary: sBatchBoundary, body: aLines.join("\n") };
}

/**
 * Resolves Basic Auth credentials for a connection from environment
 * variables named "<Credential_ALIAS>_USER" / "<Credential_ALIAS>_PASSWORD".
 */
function resolveCredentials(sCredentialAlias) {
	const sUser = process.env[`${sCredentialAlias}_USER`];
	const sPassword = process.env[`${sCredentialAlias}_PASSWORD`];

	if (!sUser || !sPassword) {
		return null;
	}
	return { user: sUser, password: sPassword };
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
	this.on("processRecords", async (req) => {
		const { connection, batchMode, purgeMode, recordsPerEntity, recordsJson } = req.data;

		let aRows;
		try {
			aRows = JSON.parse(recordsJson || "[]");
		} catch (e) {
			return req.error(400, "recordsJson no es un JSON válido");
		}

		if (!batchMode) {
			// Non-batch body shape (purge vs upsert) is still provisional
			// until its real format is defined - keeps simulating for now.
			console.log(
				`processRecords: connection=${connection} batchMode=false purgeMode=${purgeMode} recordsPerEntity=${recordsPerEntity} rows=${aRows.length}`
			);

			return aRows.map((oRow, i) => {
				const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
				const bFail = iRowIndex % 3 === 2;
				const aEntities = Object.keys(groupFieldsByEntity(oRow.fields));

				return {
					rowIndex: iRowIndex,
					status: bFail ? "ERROR" : "OK",
					replicationError: bFail
						? `Simulación: la instancia ${connection || "SFSF"} ha rechazado el registro con entidades [${aEntities.join(", ")}] (dato de ejemplo, sin conexión real todavía).`
						: ""
				};
			});
		}

		const [oConnection] = await this.read("SFSFConnections").where({ Instancia_SFSF: connection });
		if (!oConnection) {
			return req.error(400, `No existe la conexión SFSF "${connection}"`);
		}

		const oCredentials = resolveCredentials(oConnection.Credential_ALIAS);
		if (!oCredentials) {
			return req.error(
				500,
				`Faltan las variables de entorno ${oConnection.Credential_ALIAS}_USER / ${oConnection.Credential_ALIAS}_PASSWORD`
			);
		}

		// Rows are grouped so that a row without User data travels in the same
		// SFSF $batch as the preceding row that did have it. Each group is one
		// atomic changeset, so its send outcome applies to all of its rows.
		const aBatches = groupRowsIntoBatches(aRows);
		const aResults = [];

		for (const aBatchRows of aBatches) {
			const { boundary, body } = buildBatchBody(aBatchRows);
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
	});
}
