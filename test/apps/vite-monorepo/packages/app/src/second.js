import debug from 'debug';          // debug@2.6.9 with its nested ms@2.0.0, as in main.js
import ms from 'ms';                // ../../node_modules/ms: ms@2.1.3
console.log(debug('y'), ms(1000));
