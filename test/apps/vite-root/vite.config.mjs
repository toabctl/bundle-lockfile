// Vite's root is web/, not the working directory (the project, where `vite build` runs): Vite names the assets it emits
// relative to its root. web/style.css loads a font from bootstrap-icons by url(): the font file is an asset (too large
// to inline), no module - only the asset's original file name tells its package.
export default { root: 'web', build: { outDir: '../dist', emptyOutDir: true } };
