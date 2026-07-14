namespace cargaempleados;

/**
 * Reference list of SuccessFactors instances/connections the user can pick
 * as the target for a CSV load. URL_API and Credential_ALIAS point to the
 * destination and credential alias configured for the actual SFSF call
 * (not implemented yet).
 */
entity SFSFConnections {
	key Instancia_SFSF   : String(40);
	    URL_API           : String(255);
	    Credential_ALIAS   : String(100);
	    NombreSistemaSFSF : String(100);
}
