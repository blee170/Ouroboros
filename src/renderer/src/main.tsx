import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './assets/fonts/fonts.css'
import './styles.css'
import App from './App'

// xterm measures its cell grid from the font at open time: the bundled terminal font must be in before the
// first card mounts, or every card is laid out for the fallback font and redrawn once D2Coding arrives.
const render = (): void => ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
const fonts = Promise.all([document.fonts.load('13px D2Coding'), document.fonts.load('bold 13px D2Coding'), document.fonts.load('13px "Pretendard Variable"')])
// a font that never settles must not leave the window blank
Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]).then(render, render)
