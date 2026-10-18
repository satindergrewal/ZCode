/**
 * The ui package typechecks on its own, so side-effect CSS imports in component
 * sources are resolved here too. Previously only web/desktop declared *.css, which
 * made TS2882 errors when ui imported third-party styles. This local declaration
 * keeps type checking consistent with what the bundler actually does.
 */
declare module "*.css";
