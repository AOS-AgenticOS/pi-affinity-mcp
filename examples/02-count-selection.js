'use strict';
// Reports what is selected: each selected node and everything nested inside it, counted by
// SDK node class (ShapeNode, FrameTextNode, GroupNode, ...). Read-only.
// Works with Affinity 3.3.3.5004 (macOS).

const { Document } = require('/document.js');

const doc = Document.current;
if (!doc) {
    console.log('No document open.');
} else {
    const selected = doc.selection.nodes.toArray();
    const byType = {};
    let nested = 0;
    const tally = (node) => {
        const type = node[Symbol.toStringTag];   // every node class names itself
        byType[type] = (byType[type] ?? 0) + 1;
    };

    for (const node of selected) {
        tally(node);
        for (const descendant of node.children.all) {   // .all = every descendant, a Collection
            tally(descendant);
            nested += 1;
        }
    }

    console.log(JSON.stringify({
        sessionUuid: doc.sessionUuid,
        selected: selected.length,
        nested: nested,
        byType: byType,
    }, null, 2));
}
