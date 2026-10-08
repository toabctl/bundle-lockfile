import './a.scss';  // @use of a Sass partial from bulma, inlined by sass-loader
import './b.less';  // @import of normalize.less (which inlines normalize.css), inlined by less-loader
import './c.css';   // @import "tailwindcss", inlined by Tailwind's PostCSS plugin (webpack 5 only)
