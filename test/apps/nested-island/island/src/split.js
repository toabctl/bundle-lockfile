// The island as an ES module library (NESTED_SPLIT=1): is-number here, nanoid in lazy.js, normalize.css in style.css
import 'normalize.css';
import isNumber from 'is-number';
export const island = () => isNumber(1);
export const later = () => import('./lazy.js');
