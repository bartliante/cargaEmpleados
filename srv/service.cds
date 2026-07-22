/**
 * Backend entities for the SFSF upload flow. Persistence for the loaded
 * employee records is not implemented yet.
 */
service CargaEmpleadosService {
	/**
	 * Reference list of SuccessFactors instances/connections the user can
	 * pick as the target for a CSV load. Not backed by a database - read
	 * from and appended to a plain file (see srv/service.js), so no
	 * database is required to run this app in production. Destination is
	 * the alias of a BTP Destination service configuration (or, for local
	 * development, an entry in .cdsrc-private.json) that resolves the real
	 * SFSF auth - no credentials are stored here.
	 */
	entity SFSFConnections {
		key Instancia_SFSF   : String(40);
		    URL_API           : String(255);
		    Destination       : String(100);
		    NombreSistemaSFSF : String(100);
	}

	/**
	 * Registers a new SFSF connection. Usuario/Password never get persisted
	 * as-is or exposed back to the client: when bound to a real BTP
	 * Destination service, they're used once to create the actual
	 * Destination there; locally (no such binding), they're written to
	 * .cdsrc-private.json's "destinations" map instead. Either way, only
	 * the resulting Destination alias ends up on the returned/listed
	 * SFSFConnections record.
	 */
	action registerConnection(
		Instancia_SFSF    : String(40),
		URL_API           : String(255),
		NombreSistemaSFSF : String(100),
		Usuario           : String(100),
		Password          : String(100)
	) returns SFSFConnections;

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
