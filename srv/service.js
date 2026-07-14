/**
 * Splits "Entity.field" keys into a nested { Entity: { field: value } }
 * structure - the shape the real SFSF OData push will need per entity.
 */
function cookRecord(oFields) {
	const oCooked = {};

	Object.keys(oFields || {}).forEach((sHeader) => {
		const iDot = sHeader.indexOf(".");
		const sEntity = iDot === -1 ? "_" : sHeader.substring(0, iDot);
		const sField = iDot === -1 ? sHeader : sHeader.substring(iDot + 1);

		if (!oCooked[sEntity]) {
			oCooked[sEntity] = {};
		}
		oCooked[sEntity][sField] = oFields[sHeader];
	});

	return oCooked;
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

		// batchMode/purgeMode/recordsPerEntity aren't used by the simulation
		// yet, but are already received here for when the real batch/purge/
		// chunked SFSF push is implemented.
		console.log(
			`processRecords: connection=${connection} batchMode=${batchMode} purgeMode=${purgeMode} recordsPerEntity=${recordsPerEntity} rows=${aRows.length}`
		);

		// Simulated outcome: no real SFSF call yet, one out of every three
		// records is reported as failed so the UI's OK/ERROR handling can be
		// exercised end to end. The record is still "cooked" into its
		// per-entity shape so that step is already in place for later.
		return aRows.map((oRow, i) => {
			const iRowIndex = oRow.rowIndex != null ? oRow.rowIndex : i;
			const oCooked = cookRecord(oRow.fields);
			const bFail = iRowIndex % 3 === 2;

			return {
				rowIndex: iRowIndex,
				status: bFail ? "ERROR" : "OK",
				replicationError: bFail
					? `Simulación: la instancia ${connection || "SFSF"} ha rechazado el registro con entidades [${Object.keys(oCooked).join(", ")}] (dato de ejemplo, sin conexión real todavía).`
					: ""
			};
		});
	});
}
