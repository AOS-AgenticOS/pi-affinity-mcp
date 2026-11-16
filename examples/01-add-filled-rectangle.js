'use strict';
// Adds a filled rectangle to the current spread and selects it.
// setInsertionTarget(doc.currentSpread) puts the new nodes on the page; without it they render as
// nothing. The fill is node.brushFillDescriptor; there is no brushFill property.
// Works with Affinity 3.3.3.5004 (macOS).

const { Document } = require('/document.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Rectangle } = require('/geometry.js');
const { ShapeNodeDefinition } = require('/nodes.js');
const { ShapeRectangle } = require('/shapes.js');
const { Colour } = require('/colours.js');

const doc = Document.current;
if (!doc) {
    console.log('No document open - run 00-new-document.js first.');
} else {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);

    const definition = ShapeNodeDefinition.createDefault();
    definition.shape = ShapeRectangle.create();
    definition.setBoundingRectangle(new Rectangle(40, 40, 220, 140)); // x, y, width, height in spread units
    builder.addNode(definition);

    const command = builder.createCommand(true); // true = select the new nodes
    doc.executeCommand(command);

    for (const node of command.newNodes) {
        node.brushFillDescriptor = Colour.createRGBA8({ r: 255, g: 90, b: 60, alpha: 255 });
    }

    console.log(JSON.stringify({
        sessionUuid: doc.sessionUuid,
        added: command.newNodes.length,
        selected: doc.selection.nodes.toArray().length,
        filled: command.newNodes.map(n => n.hasBrushFill),
    }, null, 2));
}
