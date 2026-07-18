using cargaempleados as db from '../db/schema';

/**
 * Backend entities for the SFSF upload flow. Persistence for the loaded
 * employee records and the actual OData push to SFSF are not implemented yet.
 */
service CargaEmpleadosService {
	// Usuario/Password are excluded: this entity is read by the frontend
	// dropdown, and credentials must never reach the client. The backend
	// reads them directly from the db entity (see srv/service.js).
	@readonly entity SFSFConnections as projection on db.SFSFConnections excluding { Usuario, Password };

	type ProcessResult {
		rowIndex         : Integer;
		status           : String;
		replicationError : String;
	}

	/**
	 * Takes the previewed rows (as JSON, since their shape depends on the
	 * uploaded CSV's columns), the chosen SFSF connection and the execution
	 * options from the upload screen, and returns a per-row result. For now
	 * this only simulates the "cooking"/replication outcome - no real SFSF
	 * call is made yet.
	 */
	action processRecords(
		connection       : String,
		batchMode        : Boolean,
		purgeMode        : Boolean,
		recordsPerEntity : Integer,
		recordsJson      : LargeString
	) returns array of ProcessResult;
}
