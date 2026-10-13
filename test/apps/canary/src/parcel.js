// The canary app as Parcel builds it (parcel.html): Parcel resolves a style sheet's bare @import relative to it, so
// its own style sheet names the package with npm:; the JavaScript (main.js, its shader through @parcel/transformer-glsl)
// is the others'
import 'bl-canary-css/index.css';
import './app.parcel.css';
import './main.js';
