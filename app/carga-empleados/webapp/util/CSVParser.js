sap.ui.define([], function () {
	"use strict";

	function detectDelimiter(sHeaderLine) {
		var iComma = (sHeaderLine.match(/,/g) || []).length;
		var iSemicolon = (sHeaderLine.match(/;/g) || []).length;
		return iSemicolon > iComma ? ";" : ",";
	}

	function parseLine(sLine, sDelimiter) {
		var aFields = [];
		var sCurrent = "";
		var bInQuotes = false;

		for (var i = 0; i < sLine.length; i++) {
			var sChar = sLine[i];

			if (sChar === "\"") {
				if (bInQuotes && sLine[i + 1] === "\"") {
					sCurrent += "\"";
					i++;
				} else {
					bInQuotes = !bInQuotes;
				}
			} else if (sChar === sDelimiter && !bInQuotes) {
				aFields.push(sCurrent.trim());
				sCurrent = "";
			} else {
				sCurrent += sChar;
			}
		}
		aFields.push(sCurrent.trim());
		return aFields;
	}

	/**
	 * Parses raw CSV text into a header row and data rows.
	 * Auto-detects "," or ";" as delimiter from the header line and
	 * supports double-quoted fields (including escaped "" quotes).
	 */
	return {
		parse: function (sText) {
			var aLines = sText
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n")
				.split("\n")
				.filter(function (sLine) {
					return sLine.trim().length > 0;
				});

			if (aLines.length === 0) {
				return { headers: [], rows: [] };
			}

			var sDelimiter = detectDelimiter(aLines[0]);
			var aHeaders = parseLine(aLines[0], sDelimiter);
			var aRows = aLines.slice(1).map(function (sLine) {
				return parseLine(sLine, sDelimiter);
			});

			return { headers: aHeaders, rows: aRows };
		}
	};
});
