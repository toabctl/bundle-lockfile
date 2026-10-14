import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideClientHydration } from '@angular/platform-browser';

// zoneless (Angular 21's default; 20 needs it said, or zone.js, to prerender)
export const appConfig: ApplicationConfig = { providers: [provideZonelessChangeDetection(), provideRouter([]), provideClientHydration()] };
