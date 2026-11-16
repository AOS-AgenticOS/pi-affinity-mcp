---
name: mcp-affinity
description: Work in Affinity by Canva through its MCP tools - inspect and change documents by running JavaScript SDK scripts in the app, build layouts and artwork, render spreads to check the result, and use the app's script library. Load before any Affinity task.
---

# Working in Affinity through MCP

You act on Affinity by running JavaScript inside the app with `execute_script`. Scripts use Affinity's SDK
(`require('/document.js')`, …) and report back through `console.log()`. You check visual results with
`render_spread` and `render_selection`, which return a JPEG you can look at. The SDK documentation comes
from the same server: look APIs up instead of guessing them.

In pi the tools are named `mcp__affinity__<tool>`. Other clients name them differently; the arguments are
the same.

## If Affinity is not reachable

No `affinity` tools, or an answer like `Affinity call failed: cannot reach … Is Affinity running…`, means
the app is closed or its MCP server is switched off in Affinity's settings. Tell the user. Nothing else you
can do will fix it.

## How to work

1. **Look before you change.** Run the read-only inspection script (see Recipes) to see the open
   documents, the current one and the selection. Work on the document the user means; ask if it is unclear.
2. **Look up the API.**
   - Read the `preamble` topic once per task: it holds the SDK conventions and the hints recorded in
     earlier sessions.
   - `search_sdk_hints` with a plain-language description of the task returns hints from other sessions.
     Treat them as leads and confirm them in the docs.
   - `read_sdk_documentation_topic` for the modules you need: `document.js`, `nodes.js`, `commands.js`,
     `shapes.js`, `colours.js`, `geometry.js`, `selections.js`, `storybuilder.js`, …
     `list_sdk_documentation` gives the exact topic names.
   - Exact signatures: `ts/<module>.d.ts` for an `affinity:<module>` import, `ts/dom/<ApiName>.d.ts` for
     one native API. Valid numeric ranges: `param_ranges.min.json`, `struct_ranges.min.json`,
     `struct_array_sizes.min.json`.
3. **Run one script per step** with `execute_script`, following the script rules below, and read its
   output. A script that throws still returns normally, with the error as text: `Error: <message>`,
   then `at main:<line>:<col>` on the next line.
4. **Check the result** with `render_spread` (a whole spread) or `render_selection` (only the selected
   nodes, on transparency). Render once per change you need to see; every render adds an image to your
   context.
5. **Record what you had to discover.** When you solved something by experimenting, add one general,
   non-obvious line with `add_sdk_hint`. It is appended to the preamble of every future session, so never
   put document contents or anything private in it.
6. **Save to the script library only when the user wants it**, and only a script that ran and was
   checked. There is no tool to remove a library script.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_sdk_documentation` | — | every topic name, comma-separated |
| `read_sdk_documentation_topic` | `filename` | the topic: SDK source with JSDoc, a `.d.ts`, or JSON ranges |
| `search_sdk_hints` | `prompt` | prose hints from other sessions |
| `execute_script` | `script` | everything the script printed with `console.log()` |
| `render_spread` | `document_session_uuid`, `spread_index` (0-based) | JPEG of the spread, longest edge ≤ 1024 px |
| `render_selection` | `document_session_uuid` | JPEG of the selected nodes only |
| `list_library_scripts` | — | the titles in the user's script library, `, `-separated |
| `read_library_script` | `title` | that script's source |
| `save_script_to_library` | `title`, `description`, `code` | saves the script to the user's library |
| `add_sdk_hint` | `hint` | appends the hint to the preamble of all future sessions |
| `report_sdk_issue` | `description`, `code` (optional) | sends a bug report to the Affinity team |

`document_session_uuid` is `doc.sessionUuid`, read with a script. `report_sdk_issue` sends a real report:
use it only for a reproducible bug that contradicts the documentation, and only with the user's agreement.

## Script rules

- **Require everything.** SDK classes come from `'/module.js'` (`require('/document.js')`), native APIs from
  `'affinity:module'`. Nothing from the SDK is global: `Document` without its `require` is a
  `ReferenceError`.
- **The script body is the program.** Don't wrap it in `main()` or add `module.exports.main = main` the
  way the SDK's bundled examples do.
- **Output goes through `console.log()` only.** Log JSON (`console.log(JSON.stringify(result))`) so the
  answer is easy to read back. `alert()` and `confirm()` open a dialog in the app, and their text never
  reaches you.
- **Every call starts from scratch.** Variables, `globalThis` and properties set on SDK modules do not
  survive to the next call. Keep state in the document, or read it back with a query script.
- **Handle the expected cases** — no document open, nothing selected — with a logged message, not a throw.
- **Plain JavaScript.** The `ts/` topics are for reading signatures; no type annotations or `import` in a
  script.
- **Keep scripts short-running.** A script that runs longer than the timeout (60 s by default) is not
  sent again; the call fails with `execute_script did not answer within …s. It may still be running…`.
  Inspect the document with a read-only script before running anything else, and split big jobs into
  several scripts.

## SDK essentials

**Documents** (`/document.js`)

- `Document.current` is the active document (falsy when none is open); `Document.all` lists every open
  one. `doc.sessionUuid` identifies a document for the render tools; `doc.name` is unset until saved.
- `doc.spreads`, `doc.currentSpread`, `doc.selection`, `doc.dpi`; `doc.spreads.first.pageCount` for pages.
- New document: `NewDocumentOptions.createDefault()`, set `units` (`UnitType` from `/units.js`), `width`,
  `height`, then `Document.create(options)`.
- `Document.load(path)`, `doc.save()`, `doc.saveAs(path)`, `doc.export(…)`: read `document.js` and
  `exportableinterface.js` first. Scripts can only reach files on the Desktop (`getUserDesktopPath` in
  `application.js`), and only when the user allows file access.
- `doc.close()` closes at once and **discards unsaved changes without asking**. Close only documents you
  created, found by the `sessionUuid` you recorded when you created them.

**Collections**

- `doc.spreads`, `node.children` and `doc.selection.nodes` are Collections, not Arrays: use `.length`,
  `.first`, `.toArray()` or `for … of`. `node.children.all` walks every descendant.
- A node's class name: `node[Symbol.toStringTag]` — `ShapeNode`, `FrameTextNode`, `GroupNode`, …

**Adding nodes** (`/commands.js`, `/nodes.js`)

- Build with `AddChildNodesCommandBuilder.create()` and always call
  `builder.setInsertionTarget(doc.currentSpread)`. Without it the nodes are created on no page and render
  as nothing.
- `builder.createCommand(true)` also selects the new nodes; `doc.executeCommand(command)` applies it;
  `command.newNodes` are the nodes it created.
- Shapes: `ShapeNodeDefinition.createDefault()`, `definition.shape = ShapeRectangle.create()` (`/shapes.js`),
  `definition.setBoundingRectangle(new Rectangle(x, y, width, height))` (`/geometry.js`), in document units.
- Fill: `node.brushFillDescriptor = Colour.createRGBA8({ r, g, b, alpha })` (`/colours.js`). There is no
  `brushFill` property: assigning it does nothing, and the shape stays unfilled.
- Text: `StoryBuilder.create()` (`/storybuilder.js`), `setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat)`
  (both arguments required), `addText()` / `addParagraphBreak()`, then
  `FrameTextNodeDefinition.createFromStoryBuilder(rectangle, story)`. Text that overflows its frame is not
  shown, so make the frame large enough and check with a render.

**Selection and structure**

- Select: `doc.selection = Selection.create(doc, nodes)` (`/selections.js`).
- Group the selection: `doc.executeCommand(DocumentCommand.createGroupNodes(doc.selection))`. The other
  document-level operations are `DocumentCommand.create…` methods in `commands.js`.
- Before editing nodes on another spread, make it the current spread — but don't set the spread that is
  already current: that clears the selection.

**Beyond shapes and text**: the SDK also has AI image generation and editing, and a Dialog API for any
UI the user asks for. Prefer them to external tools; the preamble says where to read about them.

## Recipes

**Inspect** (read-only; run it first):

```javascript
const { Document } = require('/document.js');

const current = Document.current;
console.log(JSON.stringify({
    current: current ? current.sessionUuid : null,
    documents: Document.all.map(d => ({
        name: d.name,
        sessionUuid: d.sessionUuid,
        spreads: d.spreads.length,
        selected: d.selection.nodes.toArray().length,
    })),
}, null, 2));
```

**Add a filled rectangle** (the pattern for adding any node):

```javascript
const { Document } = require('/document.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Rectangle } = require('/geometry.js');
const { ShapeNodeDefinition } = require('/nodes.js');
const { ShapeRectangle } = require('/shapes.js');
const { Colour } = require('/colours.js');

const doc = Document.current;
if (!doc) {
    console.log('No document open.');
} else {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);

    const definition = ShapeNodeDefinition.createDefault();
    definition.shape = ShapeRectangle.create();
    definition.setBoundingRectangle(new Rectangle(40, 40, 220, 140));
    builder.addNode(definition);

    const command = builder.createCommand(true);
    doc.executeCommand(command);
    for (const node of command.newNodes) {
        node.brushFillDescriptor = Colour.createRGBA8({ r: 255, g: 90, b: 60, alpha: 255 });
    }

    console.log(JSON.stringify({ sessionUuid: doc.sessionUuid, added: command.newNodes.length }));
}
```

**Add a text frame**:

```javascript
const { Document } = require('/document.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Rectangle } = require('/geometry.js');
const { FrameTextNodeDefinition } = require('/nodes.js');
const { StoryBuilder } = require('/storybuilder.js');

const doc = Document.current;
if (!doc) {
    console.log('No document open.');
} else {
    const story = StoryBuilder.create();
    story.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);
    story.addText('Heading');
    story.addParagraphBreak();
    story.addText('Body text.');

    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);
    builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(40, 200, 520, 180), story));

    const command = builder.createCommand(true);
    doc.executeCommand(command);
    console.log(JSON.stringify({ sessionUuid: doc.sessionUuid, added: command.newNodes.length }));
}
```

**Work in a scratch document** (for trying things out without touching the user's files). Create it and
record its `sessionUuid`:

```javascript
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');

const options = NewDocumentOptions.createDefault();
options.units = UnitType.Pixel;
options.width = 600;
options.height = 400;
const doc = Document.create(options);   // becomes the current document
console.log(JSON.stringify({ sessionUuid: doc.sessionUuid }));
```

Build in it, check it with `render_spread`, and when you are done close exactly that document:

```javascript
const { Document } = require('/document.js');

const scratch = Document.all.find(d => d.sessionUuid === 'PASTE-THE-RECORDED-UUID');
if (scratch) scratch.close();
console.log(scratch ? 'closed' : 'not open');
```

## When a call fails

| Answer | Meaning | What to do |
| --- | --- | --- |
| `Affinity call failed: cannot reach …` | Affinity is closed or its MCP server is off | tell the user |
| `Error: <message>` … `at main:<line>:<col>` | your script threw | fix that line; re-read the topic if it is an API mistake |
| `ReferenceError: … is not defined` | missing `require` | add it |
| `TypeError: … is not a function` | the API is not what you assumed | read the `ts/` declaration |
| `NOT_ALLOWED` | the user restricted AI, file or network access for scripts | stop and tell the user; do not work around it |
| `execute_script did not answer within …s` | the script ran longer than the timeout | inspect the document, then decide |
| `No document with that Uuid exists.` | the document is closed, or the UUID is stale | read `doc.sessionUuid` again |
| `Spread index out of bounds.` | `spread_index` ≥ `doc.spreads.length` | check the count first |
| `File not found` | no such documentation topic | look the name up with `list_sdk_documentation` |
| `Script not found` | no library script with that title | look it up with `list_library_scripts` |
| `The preamble documentation topic has not yet been read.` | the client talks to Affinity directly, not through pi-affinity-mcp | tell the user to set up pi-affinity-mcp |
| `Affinity refused the handshake` | this pi-affinity-mcp is older than the Affinity protocol | tell the user to update pi-affinity-mcp |

## Never

- Write SDK calls from memory or from older Affinity versions: read the docs. Equally, don't assume the
  SDK cannot do something because older versions couldn't.
- Change or close documents the user did not ask you to touch, or leave scratch documents open.
- Render in a loop to see what happens.
- Save to the library, or report an SDK issue, without the user.
