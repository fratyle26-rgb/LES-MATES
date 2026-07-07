import { useState, useEffect } from 'react'
import axios from 'axios'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Finance from './pages/Finance'
import './App.css'

function App() {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(localStorage.getItem('token'))
  const [currentPage, setCurrentPage] = useState('dashboard')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (token) {
      verifyToken()
    } else {
      setLoading(false)
    }
  }, [token])

  const verifyToken = async () => {
    try {
      const response = await axios.post('http://localhost:3001/verify', {}, {
        headers: { Authorization: `Bearer ${token}` }
      })
      setUser(response.data.user)
      setLoading(false)
    } catch (error) {
      console.error('Token verification failed:', error)
      localStorage.removeItem('token')
      setToken(null)
      setLoading(false)
    }
  }

  const handleLogin = (token, userData) => {
    localStorage.setItem('token', token)
    setToken(token)
    setUser(userData)
    setCurrentPage('dashboard')
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
    setCurrentPage('login')
  }

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center' }}>Loading...</div>
  }

  if (!user) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app">
      <nav className="navbar">
        <h1>LES-MATES</h1>
        <div className="nav-links">
          <button onClick={() => setCurrentPage('dashboard')} className={currentPage === 'dashboard' ? 'active' : ''}>Dashboard</button>
          <button onClick={() => setCurrentPage('finance')} className={currentPage === 'finance' ? 'active' : ''}>Finance</button>
          <button onClick={handleLogout}>Logout</button>
        </div>
      </nav>
      <div className="container">
        {currentPage === 'dashboard' && <Dashboard user={user} token={token} />}
        {currentPage === 'finance' && <Finance user={user} token={token} />}
      </div>
    </div>
  )
}

export default App
