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

/**
 * Builds the atom+xml <entry> for one entity's upsert. Every field
 * (including what would be a key field, e.g. userId/personIdExternal) is
 * sent as an <m:properties> child - <id> only carries the entity name.
 */
function buildEntityXml(sEntity, oEntityFields) {
	const sProperties = Object.keys(oEntityFields)
		.map((sField) => `      <d:${sField}>${escapeXml(oEntityFields[sField])}</d:${sField}>`)
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

	return aLines.join("\n");
}

export default function () {
	this.on("processRecords", (req) => {
		const { connection, batchMode, purgeMode, recordsPerEntity, recordsJson } = req.data;

		let aRows;
		try {
			aRows = JSON.parse(recordsJson || "[]");
		} catch (e) {
			return req.error(400, "recordsJson no es un JSON válido");
		}

		if (batchMode) {
			// Rows are grouped so that a row without User data travels in the
			// same SFSF $batch as the preceding row that did have it, then one
			// batch/changeset XML body is built per group.
			const aBatches = groupRowsIntoBatches(aRows);
			console.log(`processRecords: connection=${connection} batchMode=true rows=${aRows.length} batches=${aBatches.length}`);
			aBatches.forEach((aBatchRows, i) => {
				const sBatchBody = buildBatchBody(aBatchRows);
				console.log(`--- batch ${i + 1}/${aBatches.length} (${aBatchRows.length} filas) ---\n${sBatchBody}`);
			});
		} else {
			// Non-batch body shape (purge vs upsert) is still provisional
			// until its real format is defined.
			console.log(
				`processRecords: connection=${connection} batchMode=false purgeMode=${purgeMode} recordsPerEntity=${recordsPerEntity} rows=${aRows.length}`
			);
		}

		// Simulated outcome: no real SFSF call yet, one out of every three
		// records is reported as failed so the UI's OK/ERROR handling can be
		// exercised end to end.
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
	});
}
