sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/table/Column",
	"sap/m/Label",
	"sap/m/Text",
	"sap/m/ObjectStatus",
	"sap/m/MessageToast",
	"cargaempleados/util/CSVParser"
], function (Controller, JSONModel, Column, Label, Text, ObjectStatus, MessageToast, CSVParser) {
	"use strict";

	var MAX_VISIBLE_ROWS = 20;

	var STATUS = {
		PENDING: "Pendiente",
		OK: "OK",
		ERROR: "ERROR"
	};

	var STATUS_META = {};
	STATUS_META[STATUS.PENDING] = { icon: "sap-icon://alert", state: "Warning" };
	STATUS_META[STATUS.OK] = { icon: "sap-icon://sys-enter-2", state: "Success" };
	STATUS_META[STATUS.ERROR] = { icon: "sap-icon://error", state: "Error" };

	return Controller.extend("cargaempleados.controller.Main", {

		onInit: function () {
			this._oFile = null;

			this.getView().setModel(new JSONModel({
				previewEnabled: false,
				clearEnabled: false,
				statusVisible: false,
				statusText: "",
				statusType: "None",
				fileNameText: "",
				countText: "",
				batchMode: false,
				purgeMode: false,
				recordsPerEntity: 100,
				selectedConnection: "",
				processEnabled: false,
				hasSelection: false,
				processing: false
			}), "ui");

			this.getView().setModel(new JSONModel({
				headers: [],
				rows: []
			}), "preview");
		},

		onTypeMismatch: function () {
			this._oFile = null;
			this._setStatus("Error", this._text("msgFileNotCsv"));
			this._setUi({ previewEnabled: false });
		},

		onFileChange: function (oEvent) {
			var aFiles = oEvent.getParameter("files");
			var oFile = aFiles && aFiles[0];

			if (!oFile) {
				this._oFile = null;
				this._setUi({ previewEnabled: false });
				return;
			}

			if (!/\.csv$/i.test(oFile.name)) {
				this._oFile = null;
				this._setStatus("Error", this._text("msgFileNotCsv"));
				this._setUi({ previewEnabled: false });
				return;
			}

			this._oFile = oFile;
			this._setStatus("None", "", false);
			this._setUi({ previewEnabled: true });
		},

		onPreview: function () {
			if (!this._oFile) {
				this._setStatus("Warning", this._text("noFileSelected"));
				return;
			}

			var oReader = new FileReader();

			oReader.onload = function (oLoadEvent) {
				this._renderPreview(oLoadEvent.target.result);
			}.bind(this);

			oReader.onerror = function () {
				this._setStatus("Error", this._text("msgParseError"));
			}.bind(this);

			oReader.readAsText(this._oFile, "UTF-8");
		},

		onClear: function () {
			this._oFile = null;
			this.byId("fileUploader").clear();

			this.getView().getModel("preview").setData({ headers: [], rows: [] });

			var oTable = this.byId("employeesTable");
			oTable.removeAllColumns();
			oTable.clearSelection();
			oTable.setVisibleRowCount(1);

			this._setUi({
				previewEnabled: false,
				clearEnabled: false,
				processEnabled: false,
				hasSelection: false,
				processing: false,
				fileNameText: "",
				countText: ""
			});
			this._setStatus("None", "", false);
			this.byId("uploadPanel").setExpanded(true);
		},

		onRowSelectionChange: function () {
			this._setUi({ hasSelection: this.byId("employeesTable").getSelectedIndices().length > 0 });
		},

		onProcess: function () {
			var oPreviewModel = this.getView().getModel("preview");
			var oPreviewData = oPreviewModel.getData();
			var aRows = oPreviewData.rows;
			var aHeaders = oPreviewData.headers;

			if (!aRows || aRows.length === 0) {
				this._setStatus("Warning", this._text("msgNoRowsToProcess"));
				return;
			}

			var aSelectedIndices = this.byId("employeesTable").getSelectedIndices();
			if (aSelectedIndices.length === 0) {
				this._setStatus("Warning", this._text("msgNoRowsSelected"));
				return;
			}

			var oUiModel = this.getView().getModel("ui");
			var sConnection = oUiModel.getProperty("/selectedConnection");
			if (!sConnection) {
				this._setStatus("Warning", this._text("msgSelectConnection"));
				return;
			}

			// The table binds cells by positional "colN" properties, but the
			// backend needs the actual SFSF entity.field each column represents
			// to be able to "cook" the record, so re-key every selected row by
			// header. The original row index is kept so the result can be
			// matched back to the right row once the backend responds.
			var aPayloadRows = aSelectedIndices.map(function (iRowIndex) {
				var oRow = aRows[iRowIndex];
				var oFields = {};
				aHeaders.forEach(function (sHeader, iCol) {
					oFields[sHeader] = oRow["col" + iCol];
				});
				return { rowIndex: iRowIndex, fields: oFields };
			});

			this._setUi({ processing: true });
			this._setStatus("None", "", false);

			fetch("/odata/v4/carga-empleados/processRecords", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					connection: sConnection,
					batchMode: oUiModel.getProperty("/batchMode"),
					purgeMode: oUiModel.getProperty("/purgeMode"),
					recordsPerEntity: oUiModel.getProperty("/recordsPerEntity"),
					recordsJson: JSON.stringify(aPayloadRows)
				})
			}).then(function (oResponse) {
				if (!oResponse.ok) {
					throw new Error("HTTP " + oResponse.status);
				}
				return oResponse.json();
			}).then(function (oResult) {
				var aResults = oResult.value || oResult;
				var iOk = 0;
				var iError = 0;

				aResults.forEach(function (oRowResult) {
					oPreviewModel.setProperty("/rows/" + oRowResult.rowIndex + "/status", oRowResult.status);
					oPreviewModel.setProperty("/rows/" + oRowResult.rowIndex + "/replicationError", oRowResult.replicationError || "");
					if (oRowResult.status === STATUS.OK) {
						iOk++;
					} else {
						iError++;
					}
				});

				this._setUi({ processing: false });
				this._setStatus(iError > 0 ? "Warning" : "Success", this._text("msgProcessResult", [iOk, iError]));
				MessageToast.show(this._text("msgProcessResult", [iOk, iError]));
			}.bind(this)).catch(function () {
				this._setUi({ processing: false });
				this._setStatus("Error", this._text("msgProcessError"));
			}.bind(this));
		},

		_renderPreview: function (sCsvText) {
			var oParsed = CSVParser.parse(sCsvText);
			var aHeaders = oParsed.headers;
			var aRawRows = oParsed.rows;

			if (aHeaders.length === 0) {
				this._setStatus("Error", this._text("msgEmptyFile"));
				return;
			}
			if (aRawRows.length === 0) {
				this._setStatus("Warning", this._text("msgOnlyHeader"));
			}

			var aRows = aRawRows.map(function (aCells) {
				var oRow = { status: STATUS.PENDING, replicationError: "" };
				aHeaders.forEach(function (sHeader, i) {
					oRow["col" + i] = aCells[i] !== undefined ? aCells[i] : "";
				});
				return oRow;
			});

			this.getView().getModel("preview").setData({
				headers: aHeaders,
				rows: aRows
			});

			this._buildDynamicColumns(aHeaders);
			var oTable = this.byId("employeesTable");
			oTable.clearSelection();
			oTable.setVisibleRowCount(Math.min(Math.max(aRows.length, 1), MAX_VISIBLE_ROWS));

			this._setUi({
				clearEnabled: true,
				processEnabled: aRows.length > 0,
				hasSelection: false,
				fileNameText: this._text("previewFileName", [this._oFile.name]),
				countText: this._text("previewCount", [aRows.length])
			});

			if (aRawRows.length > 0) {
				this._setStatus("Success", this._text("msgPreviewOk", [aRows.length, aHeaders.length]));
				MessageToast.show(this._text("msgPreviewOk", [aRows.length, aHeaders.length]));
				this.byId("uploadPanel").setExpanded(false);
			}
		},

		/**
		 * Each CSV header identifies an SFSF entity and field, e.g. "User.userId" or
		 * "PerPerson.personIdExternal". Splits on the first "." into { entity, field }.
		 * Headers without a "." are treated as an entity-less field.
		 */
		_splitHeader: function (sHeader) {
			var iDot = sHeader.indexOf(".");
			if (iDot === -1) {
				return { entity: "", field: sHeader };
			}
			return { entity: sHeader.substring(0, iDot), field: sHeader.substring(iDot + 1) };
		},

		/**
		 * Groups consecutive columns that belong to the same SFSF entity, so the
		 * entity name can be rendered as a single merged header cell spanning
		 * all of its field columns.
		 */
		_groupHeadersByEntity: function (aHeaders) {
			var aGroups = [];

			aHeaders.forEach(function (sHeader, iColIndex) {
				var oSplit = this._splitHeader(sHeader);
				var oLastGroup = aGroups[aGroups.length - 1];

				if (oLastGroup && oLastGroup.entity === oSplit.entity) {
					oLastGroup.columns.push({ field: oSplit.field, colIndex: iColIndex });
				} else {
					aGroups.push({
						entity: oSplit.entity,
						columns: [{ field: oSplit.field, colIndex: iColIndex }]
					});
				}
			}, this);

			return aGroups;
		},

		_buildDynamicColumns: function (aHeaders) {
			var oTable = this.byId("employeesTable");
			oTable.removeAllColumns();

			oTable.addColumn(new Column({
				multiLabels: [
					new Label({ text: "" }),
					new Label({ text: this._text("statusColumnLabel") })
				],
				headerSpan: [1, 1],
				template: new ObjectStatus({
					text: "{preview>status}",
					icon: { path: "preview>status", formatter: this._formatStatusIcon },
					state: { path: "preview>status", formatter: this._formatStatusState }
				}),
				width: "9rem"
			}));

			var aGroups = this._groupHeadersByEntity(aHeaders);

			aGroups.forEach(function (oGroup) {
				var iSpan = oGroup.columns.length;

				oGroup.columns.forEach(function (oColumnInfo, iIndexInGroup) {
					var bFirstInGroup = iIndexInGroup === 0;

					oTable.addColumn(new Column({
						multiLabels: [
							new Label({ text: bFirstInGroup ? oGroup.entity : "" }),
							new Label({ text: oColumnInfo.field })
						],
						headerSpan: bFirstInGroup ? [iSpan, 1] : [1, 1],
						template: new Text({ text: "{preview>col" + oColumnInfo.colIndex + "}" }),
						width: "12rem"
					}));
				});
			});

			oTable.addColumn(new Column({
				multiLabels: [
					new Label({ text: "" }),
					new Label({ text: this._text("replicationErrorColumnLabel") })
				],
				headerSpan: [1, 1],
				template: new Text({ text: "{preview>replicationError}" }),
				width: "16rem"
			}));
		},

		_formatStatusIcon: function (sStatus) {
			return (STATUS_META[sStatus] || {}).icon || "";
		},

		_formatStatusState: function (sStatus) {
			return (STATUS_META[sStatus] || {}).state || "None";
		},

		_setUi: function (oPartial) {
			var oModel = this.getView().getModel("ui");
			Object.keys(oPartial).forEach(function (sKey) {
				oModel.setProperty("/" + sKey, oPartial[sKey]);
			});
		},

		_setStatus: function (sType, sText, bVisible) {
			this._setUi({
				statusType: sType,
				statusText: sText,
				statusVisible: bVisible !== false && !!sText
			});
		},

		_text: function (sKey, aArgs) {
			return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
		}
	});
});
