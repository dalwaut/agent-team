import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// CSS is imported inside App to ensure it loads after Tailwind base

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
