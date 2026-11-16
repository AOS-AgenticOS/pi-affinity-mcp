'use strict';
// Adds a text frame with default frame-text styling to the current spread.
// Works with Affinity 3.3.3.5004 (macOS).

const { Document } = require('/document.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Rectangle } = require('/geometry.js');
const { FrameTextNodeDefinition } = require('/nodes.js');
const { StoryBuilder } = require('/storybuilder.js');

const doc = Document.current;
if (!doc) {
    console.log('No document open - run 00-new-document.js first.');
} else {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);

    const story = StoryBuilder.create();
    story.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);  // both arguments are required
    story.addText('Hello from a script');                          // addText / addParagraphBreak / clearText
    story.addParagraphBreak();
    story.addText('Second paragraph.');

    const definition = FrameTextNodeDefinition.createFromStoryBuilder(
        new Rectangle(40, 200, 520, 180),  // x, y, width, height - a frame too small hides the overflow
        story,
    );
    builder.addNode(definition);

    const command = builder.createCommand(true);
    doc.executeCommand(command);

    console.log(JSON.stringify({
        sessionUuid: doc.sessionUuid,
        added: command.newNodes.length,
        types: command.newNodes.map(n => String(n)),  // e.g. "[object FrameTextNode]"
    }, null, 2));
}
