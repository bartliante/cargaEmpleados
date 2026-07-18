namespace cargaempleados;

/**
 * Reference list of SuccessFactors instances/connections the user can pick
 * as the target for a CSV load. URL_API is the OData root, Usuario/Password
 * are the Basic Auth credentials used for the actual SFSF call.
 */
entity SFSFConnections {
	key Instancia_SFSF   : String(40);
	    URL_API           : String(255);
	    Usuario           : String(100);
	    Password          : String(100);
	    NombreSistemaSFSF : String(100);
}
