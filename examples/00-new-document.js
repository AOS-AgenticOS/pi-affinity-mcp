'use strict';
// Creates a new unsaved pixel document and logs its session UUID.
// The UUID is what render_spread / render_selection expect as document_session_uuid.
// Works with Affinity 3.3.3.5004 (macOS).

const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');

const opts = NewDocumentOptions.createDefault();
opts.units = UnitType.Pixel;
opts.width = 600;
opts.height = 400;

const doc = Document.create(opts);

console.log(JSON.stringify({
    name: doc.name,              // undefined for a new unsaved document
    sessionUuid: doc.sessionUuid, // uppercase UUID, use verbatim for render_* tools
    dpi: doc.dpi,
    spreads: doc.spreads.length,  // Collection: use .length / .first / .toArray()
    pages: doc.spreads.first.pageCount,
}, null, 2));
