import ms from 'ms'; // server only, a dependency: kept external by Vite's SSR build and adapter-node
export const load = () => ({ took: ms(1500) });
