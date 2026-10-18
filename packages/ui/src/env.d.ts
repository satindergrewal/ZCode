/// <reference types="node" />

// ui targets the browser, but a few modules (e.g. logger's production check) read
// process.env; reference node types explicitly so the globals never silently vanish.
