// EDGE_ASSET=data-js: a JavaScript module from a data: URL (webpack 5 reads data: URLs itself), next to a package asset
import one from 'data:text/javascript,export default 1';
import alarmUrl from 'bootstrap-icons/icons/alarm.svg';
console.log(one, alarmUrl);
