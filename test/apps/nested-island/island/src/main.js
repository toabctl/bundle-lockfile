// The island: a library built by Vite into one self-contained file (like GitLab's ee/frontend_islands)
import isNumber from 'is-number';
import { nanoid } from 'nanoid';
window.island = () => (isNumber(1) ? nanoid() : '');
