import './App.css'
import HomeDashboard from './routes/HomeDashboard'
import HubSpotCallReport from './routes/HubSpotCallReport'

const routes = {
  '/': HomeDashboard,
  '/home': HomeDashboard,
  '/call-report': HubSpotCallReport,
}

function App() {
  const currentPath = window.location.pathname
  const ActiveRoute = routes[currentPath] ?? HomeDashboard
  const tabs = [
    { href: '/home', label: 'Home' },
    { href: '/call-report', label: 'Call Report' },
  ]

  return (
    <main className="app-shell">
      <header className="topbar" aria-label="Primary">
        <a className="brand" href="/" aria-label="Production Tool Home">
          Production Tool
        </a>
        <nav className="nav-tabs" aria-label="Dashboard">
          {tabs.map((tab) => (
            <a
              className={`nav-tab${currentPath === tab.href || (currentPath === '/' && tab.href === '/home') ? ' active' : ''}`}
              href={tab.href}
              key={tab.href}
            >
              {tab.label}
            </a>
          ))}
        </nav>
      </header>
      <ActiveRoute />
    </main>
  )
}

export default App
