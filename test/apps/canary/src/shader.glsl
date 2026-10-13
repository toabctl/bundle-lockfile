#include "bl-canary-glsl/noise.glsl"
void main() { gl_FragColor = vec4(noise(gl_FragCoord.xyz)); }
