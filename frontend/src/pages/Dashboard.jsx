import { useEffect, useState } from 'react'
import axios from 'axios'
import './Dashboard.css'

function Dashboard({ user, token }) {
  const [stats, setStats] = useState({
    totalAccounts: 0,
    totalJournals: 0,
    accountsBalance: 0
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDashboardData()
  }, [])

  const loadDashboardData = async () => {
    try {
      setLoading(true)
      // Get user organization (assume first organization)
      const orgResult = await axios.get('http://localhost:3003/organizations/1', {
        headers: { Authorization: `Bearer ${token}` }
      })

      const orgId = orgResult.data.id

      // Load accounts
      const accountsRes = await axios.get(`http://localhost:3004/accounts/${orgId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      setStats({
        totalAccounts: accountsRes.data.accounts.length,
        totalJournals: 0,
        accountsBalance: accountsRes.data.accounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0)
      })
    } catch (error) {
      console.error('Dashboard load error:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div>Loading dashboard...</div>
  }

  return (
    <div className="dashboard">
      <h2>Dashboard</h2>
      <p>Welcome, {user.first_name || user.email}</p>
      <div className="stats-grid">
        <div className="stat-card">
          <h3>{stats.totalAccounts}</h3>
          <p>Active Accounts</p>
        </div>
        <div className="stat-card">
          <h3>{stats.totalJournals}</h3>
          <p>Journal Entries</p>
        </div>
        <div className="stat-card">
          <h3>${stats.accountsBalance.toFixed(2)}</h3>
          <p>Total Balance</p>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
