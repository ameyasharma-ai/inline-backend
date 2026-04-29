import express, { Response, Request } from "express"
import dotenv from "dotenv"
import http from "http"
import cors from "cors"
import { SocketEvent, SocketId } from "./types/socket"
import { USER_CONNECTION_STATUS, User } from "./types/user"
import { Server } from "socket.io"
import path from "path"

dotenv.config()

const app = express()

app.use(express.json())

app.use(cors())

app.use(express.static(path.join(__dirname, "public"))) // Serve static files

const server = http.createServer(app)
const io = new Server(server, {
	cors: {
		origin: "*",
	},
	maxHttpBufferSize: 1e8,
	pingTimeout: 60000,
})

let userSocketMap: User[] = []
const roomPasswords = new Map<string, string>()

// Track room activity to auto-close unattended rooms (30 minutes)
const roomActivity = new Map<string, number>()
const ROOM_TIMEOUT_MS = 30 * 60 * 1000

// Function to update room activity
function updateRoomActivity(roomId: string) {
    if (roomId) {
        roomActivity.set(roomId, Date.now())
    }
}

// Function to get all users in a room
function getUsersInRoom(roomId: string): User[] {
	return userSocketMap.filter((user) => user.roomId == roomId)
}

// Function to get room id by socket id
function getRoomId(socketId: SocketId): string | null {
	const roomId = userSocketMap.find(
		(user) => user.socketId === socketId
	)?.roomId

	if (!roomId) {
		console.error("Room ID is undefined for socket ID:", socketId)
		return null
	}
	return roomId
}

function getUserBySocketId(socketId: SocketId): User | null {
	const user = userSocketMap.find((user) => user.socketId === socketId)
	if (!user) {
		return null
	}
	return user
}

io.on("connection", (socket) => {
	// Handle user actions
	socket.on(SocketEvent.JOIN_REQUEST, ({ roomId, username, password }) => {
		// Check is username exist in the room
		const isUsernameExist = getUsersInRoom(roomId).filter(
			(u) => u.username === username
		)
		if (isUsernameExist.length > 0) {
			io.to(socket.id).emit(SocketEvent.USERNAME_EXISTS)
			return
		}

		// Check room password
		const roomUsers = getUsersInRoom(roomId)
		if (roomUsers.length > 0) {
			// Room already exists, verify password
			const expectedPassword = roomPasswords.get(roomId)
			if (expectedPassword !== password) {
				io.to(socket.id).emit(SocketEvent.JOIN_ERROR, { error: "Incorrect room password" })
				return
			}
		} else {
			// Room is new, store password
			if (password && password.length >= 4 && password.length <= 8) {
				roomPasswords.set(roomId, password)
			} else {
				io.to(socket.id).emit(SocketEvent.JOIN_ERROR, { error: "Room password must be between 4 and 8 characters" })
				return
			}
		}

		const user = {
			username,
			roomId,
			status: USER_CONNECTION_STATUS.ONLINE,
			cursorPosition: 0,
			typing: false,
			socketId: socket.id,
			currentFile: null,
		}
		userSocketMap.push(user)
		socket.join(roomId)
		socket.broadcast.to(roomId).emit(SocketEvent.USER_JOINED, { user })
		const users = getUsersInRoom(roomId)
		io.to(socket.id).emit(SocketEvent.JOIN_ACCEPTED, { user, users })
	})

	socket.on("disconnecting", () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.USER_DISCONNECTED, { user })
		userSocketMap = userSocketMap.filter((u) => u.socketId !== socket.id)
		socket.leave(roomId)

		// Clean up room password if room is empty
		if (getUsersInRoom(roomId).length === 0) {
			roomPasswords.delete(roomId)
            roomActivity.delete(roomId)
		} else {
            updateRoomActivity(roomId)
        }
	})

	// Handle file actions
	socket.on(
		SocketEvent.SYNC_FILE_STRUCTURE,
		({ fileStructure, openFiles, activeFile, socketId }) => {
            const roomId = getRoomId(socket.id)
            if (roomId) updateRoomActivity(roomId)
			io.to(socketId).emit(SocketEvent.SYNC_FILE_STRUCTURE, {
				fileStructure,
				openFiles,
				activeFile,
			})
		}
	)

	socket.on(
		SocketEvent.DIRECTORY_CREATED,
		({ parentDirId, newDirectory }) => {
			const roomId = getRoomId(socket.id)
			if (!roomId) return
			socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_CREATED, {
				parentDirId,
				newDirectory,
			})
		}
	)

	socket.on(SocketEvent.DIRECTORY_UPDATED, ({ dirId, children }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_UPDATED, {
			dirId,
			children,
		})
	})

	socket.on(SocketEvent.DIRECTORY_RENAMED, ({ dirId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_RENAMED, {
			dirId,
			newName,
		})
	})

	socket.on(SocketEvent.DIRECTORY_DELETED, ({ dirId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.DIRECTORY_DELETED, { dirId })
	})

	socket.on(SocketEvent.FILE_CREATED, ({ parentDirId, newFile }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.FILE_CREATED, { parentDirId, newFile })
	})

	socket.on(SocketEvent.FILE_UPDATED, ({ fileId, newContent }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_UPDATED, {
			fileId,
			newContent,
		})
	})

	socket.on(SocketEvent.FILE_RENAMED, ({ fileId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_RENAMED, {
			fileId,
			newName,
		})
	})

	socket.on(SocketEvent.FILE_DELETED, ({ fileId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_DELETED, { fileId })
	})

	// Handle user status
	socket.on(SocketEvent.USER_OFFLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.OFFLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_OFFLINE, { socketId })
	})

	socket.on(SocketEvent.USER_ONLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.ONLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_ONLINE, { socketId })
	})

	// Handle chat actions
	socket.on(SocketEvent.SEND_MESSAGE, ({ message }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.RECEIVE_MESSAGE, { message })
	})

	// Handle cursor position and selection
	socket.on(SocketEvent.TYPING_START, ({ cursorPosition, selectionStart, selectionEnd }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return {
					...user,
					typing: true,
					cursorPosition,
					selectionStart,
					selectionEnd
				}
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_START, { user })
	})

	socket.on(SocketEvent.TYPING_PAUSE, () => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: false }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_PAUSE, { user })
	})

	// Handle cursor movement without typing
	socket.on(SocketEvent.CURSOR_MOVE, ({ cursorPosition, selectionStart, selectionEnd }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return {
					...user,
					cursorPosition,
					selectionStart,
					selectionEnd
				}
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.CURSOR_MOVE, { user })
	})

	socket.on(SocketEvent.REQUEST_DRAWING, () => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.REQUEST_DRAWING, { socketId: socket.id })
	})

	socket.on(SocketEvent.SYNC_DRAWING, ({ drawingData, socketId }) => {
		socket.broadcast
			.to(socketId)
			.emit(SocketEvent.SYNC_DRAWING, { drawingData })
	})

	socket.on(SocketEvent.DRAWING_UPDATE, ({ snapshot }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
        updateRoomActivity(roomId)
		socket.broadcast.to(roomId).emit(SocketEvent.DRAWING_UPDATE, {
			snapshot,
		})
	})

	// Handle WebRTC signaling
	socket.on(SocketEvent.SEND_RTC_OFFER, ({ offer, targetId }) => {
		socket.to(targetId).emit(SocketEvent.RECEIVE_RTC_OFFER, {
			offer,
			senderId: socket.id,
		})
	})

	socket.on(SocketEvent.SEND_RTC_ANSWER, ({ answer, targetId }) => {
		socket.to(targetId).emit(SocketEvent.RECEIVE_RTC_ANSWER, {
			answer,
			senderId: socket.id,
		})
	})

	socket.on(SocketEvent.SEND_ICE_CANDIDATE, ({ candidate, targetId }) => {
		socket.to(targetId).emit(SocketEvent.RECEIVE_ICE_CANDIDATE, {
			candidate,
			senderId: socket.id,
		})
	})

	socket.on("RTC_CALL_START", ({ roomId }) => {
		socket.broadcast.to(roomId).emit("RTC_CALL_INVITE", {
			senderId: socket.id,
			senderName: getUserBySocketId(socket.id)?.username || "Someone"
		})
	})

	socket.on("RTC_PROCEED_OFFER", ({ targetId }) => {
		socket.to(targetId).emit("RTC_READY_TO_RECEIVE", {
			senderId: socket.id
		})
	})
})

// Prune unattended rooms every minute
setInterval(() => {
    const now = Date.now()
    for (const [roomId, lastActivity] of roomActivity.entries()) {
        if (now - lastActivity > ROOM_TIMEOUT_MS) {
            console.log(`Room ${roomId} has been idle for 30 minutes. Closing room.`)
            // Notify all clients in the room
            io.to(roomId).emit("SESSION_TIMEOUT")
            
            // Clean up server state
            roomPasswords.delete(roomId)
            roomActivity.delete(roomId)
            userSocketMap = userSocketMap.filter((u) => u.roomId !== roomId)
            
            // Disconnect all sockets in the room
            io.in(roomId).disconnectSockets(true)
        }
    }
}, 60 * 1000)

const PORT = process.env.PORT || 3000

app.get("/api/room/:roomId", (req: Request, res: Response) => {
	const roomId = req.params.roomId
	const roomUsers = getUsersInRoom(roomId)
	if (roomUsers.length > 0) {
		res.json({ exists: true })
	} else {
		res.json({ exists: false })
	}
})

app.post("/api/copilot", async (req: Request, res: Response) => {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		return res.status(500).json({ error: "Server is missing OpenRouter API Key configuration." })
	}
	
	try {
		const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`
			},
			body: JSON.stringify(req.body)
		})
		
		const data = await response.json()
		
		if (!response.ok) {
			return res.status(response.status).json(data)
		}
		
		res.json(data)
	} catch (error: any) {
		console.error("OpenRouter Proxy Error:", error)
		res.status(500).json({ error: { message: "Failed to communicate with OpenRouter API" } })
	}
})

app.get("/api/languages", async (req: Request, res: Response) => {
	const judge0Url = process.env.JUDGE0_API_URL || "https://ce.judge0.com"
	try {
		const response = await fetch(`${judge0Url}/languages`)
		const data = await response.json()
		if (!response.ok) return res.status(response.status).json(data)
		res.json(data)
	} catch (error: any) {
		console.error("Judge0 Languages Proxy Error:", error)
		res.status(500).json({ error: { message: "Failed to fetch languages from Judge0" } })
	}
})

app.post("/api/submissions", async (req: Request, res: Response) => {
	const judge0Url = process.env.JUDGE0_API_URL || "https://ce.judge0.com"
	try {
		const response = await fetch(`${judge0Url}/submissions?wait=true&base64_encoded=true`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(req.body)
		})
		const data = await response.json()
		if (!response.ok) return res.status(response.status).json(data)
		res.json(data)
	} catch (error: any) {
		console.error("Judge0 Submissions Proxy Error:", error)
		res.status(500).json({ error: { message: "Failed to execute code on Judge0" } })
	}
})

app.get("*", (req: Request, res: Response) => {
	// Send the index.html file
	res.sendFile(path.join(__dirname, "..", "public", "index.html"))
})

server.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`)
})
