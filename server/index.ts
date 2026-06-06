import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import {
  getEnrichedGroups,
  getLights,
  setLightState,
  setGroupAction
} from './hue'

config()

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

app.use(cors())
app.use(express.json())

app.get('/api/groups', async (_req, res) => {
  try {
    const groups = await getEnrichedGroups()
    res.json(groups)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch groups' })
  }
})

app.get('/api/lights', async (_req, res) => {
  try {
    const lights = await getLights()
    res.json(Object.values(lights))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch lights' })
  }
})

app.put('/api/lights/:id/state', async (req, res) => {
  try {
    const result = await setLightState(req.params.id, req.body)
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to set light state' })
  }
})

app.put('/api/groups/:id/state', async (req, res) => {
  try {
    const result = await setGroupAction(req.params.id, req.body)
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to set group state' })
  }
})

app.listen(PORT, () => {
  console.log(`Hue manager server running on http://localhost:${PORT}`)
})
