import { chunk } from 'lodash-es';
import './features.scss'; // esbuild-sass-plugin: @use of a Sass partial from bulma, which the plugin inlines (no module)
console.log(chunk([1, 2, 3, 4], 2));
