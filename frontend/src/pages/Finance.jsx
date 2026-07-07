import { useState, useEffect } from 'react'
import axios from 'axios'
import './Finance.css'

function Finance({ user, token }) {
  const [tab, setTab] = useState('coa')
  const [accounts, setAccounts] = useState([])
  const [journals, setJournals] = useState([])
  const [trialBalance, setTrialBalance] = useState(null)
  const [loading, setLoading] = useState(false)
  const [orgId] = useState(1) // Default org for demo

  useEffect(() => {
    if (tab === 'coa') loadAccounts()
    else if (tab === 'journal') loadJournals()
    else if (tab === 'ledger') loadTrialBalance()
  }, [tab])

  const loadAccounts = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`http://localhost:3004/accounts/${orgId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      setAccounts(res.data.accounts)
    } catch (error) {
      console.error('Load accounts error:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadJournals = async () => {
    try {
      setLoading(true)
      // Load journals - would need endpoint
      setJournals([])
    } catch (error) {
      console.error('Load journals error:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadTrialBalance = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`http://localhost:3004/trial-balance/${orgId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      setTrialBalance(res.data)
    } catch (error) {
      console.error('Load trial balance error:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="finance">
      <h2>Finance Module</h2>
      <div className="tabs">
        <button className={tab === 'coa' ? 'active' : ''} onClick={() => setTab('coa')}>Chart of Accounts</button>
        <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>Journal Entries</button>
        <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>Trial Balance</button>
      </div>

      <div className="tab-content">
        {tab === 'coa' && (
          <div>
            <h3>Chart of Accounts</h3>
            {loading ? <p>Loading...</p> : (
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(acc => (
                    <tr key={acc.id}>
                      <td>{acc.account_number}</td>
                      <td>{acc.account_name}</td>
                      <td>{acc.account_type}</td>
                      <td>${parseFloat(acc.balance).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'journal' && (
          <div>
            <h3>Journal Entries</h3>
            <p>Create and post journal entries here</p>
          </div>
        )}

        {tab === 'ledger' && (
          <div>
            <h3>Trial Balance</h3>
            {loading ? <p>Loading...</p> : trialBalance && (
              <div>
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Type</th>
                      <th>Debit</th>
                      <th>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trialBalance.accounts.map((acc, i) => (
                      <tr key={i}>
                        <td>{acc.account_name}</td>
                        <td>{acc.account_type}</td>
                        <td>{acc.account_type === 'ASSET' || acc.account_type === 'EXPENSE' ? acc.balance : '0.00'}</td>
                        <td>{acc.account_type === 'LIABILITY' || acc.account_type === 'EQUITY' || acc.account_type === 'REVENUE' ? acc.balance : '0.00'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ marginTop: '20px' }}>
                  <strong>Total Debit:</strong> ${trialBalance.total_debit}
                </p>
                <p>
                  <strong>Total Credit:</strong> ${trialBalance.total_credit}
                </p>
                <p style={{ color: trialBalance.is_balanced ? 'green' : 'red' }}>
                  <strong>Balanced: {trialBalance.is_balanced ? 'YES ✓' : 'NO ✗'}</strong>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default Finance
