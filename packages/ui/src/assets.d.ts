declare module "*.css";
declare module "*.mp3";
declare module "*.png";
declare module "*.svg";
declare module "*.webp";

// Vite `?url` asset imports (e.g. the pdf.js worker) resolve to the bundled asset URL string.
declare module "*?url" {
  const src: string;
  export default src;
}
