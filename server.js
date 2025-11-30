// server.js
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use(cookieParser());

// Serve static files (librarian.html, login.html) from "public" folder
app.use(express.static(path.join(__dirname, "public")));

// ---------- IN-MEMORY "DATABASE" ----------

// Users stored as { id, name, email, password, role }
// NOTE: password is plaintext here for simplicity – NOT for production
let users = [
  {
    id: 1,
    name: "Admin Librarian",
    email: "admin@example.com",
    password: "admin123", // change this
    role: "librarian",
  },
];

// Books stored as { id, title, author, rfid_tag }
let books = [];

// Loans: borrow/return records
// { id, bookId, userId, borrowedAt, returnedAt (null if not yet returned) }
let loans = [];

// Last tag scanned on the check-in (non-moving) reader
let latestCheckinTag = null; // { tag, seenAt }

// Shelf scan session
let currentScan = null;       // { id, tags: Set, startedAt }
let lastCompletedScan = null; // { id, tags: [...], startedAt, finishedAt }

// Motor command that ESP32 polls via GET /api/motor
let pendingMotorCommand = { steps: 0, stop: false };

// ---------- SESSIONS (VERY SIMPLE) ----------
const sessions = new Map(); // sid -> { userId, role }

function createSession(userId, role) {
  const sid = crypto.randomBytes(16).toString("hex");
  sessions.set(sid, { userId, role });
  return sid;
}

function getUserFromReq(req) {
  const sid = req.cookies.sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  const user = users.find((u) => u.id === session.userId);
  return user || null;
}

// Middlewares for protection
function requireLogin(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  req.user = user;
  next();
}

function requireLibrarian(req, res, next) {
  const user = getUserFromReq(req);
  if (!user || user.role !== "librarian") {
    return res.status(403).json({ error: "Librarian only" });
  }
  req.user = user;
  next();
}

// ---------- AUTH ENDPOINTS ----------

// Register new user (used by login.html "Add user" form)
// Body: { name, email, password, role }
app.post("/auth/register", (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, password are required" });
  }
  const userRole = role === "librarian" ? "librarian" : "student";

  const existing = users.find((u) => u.email === email);
  if (existing) {
    return res.status(400).json({ error: "User with this email already exists" });
  }

  const newUser = {
    id: users.length + 1,
    name,
    email,
    password, // plaintext for now
    role: userRole,
  };
  users.push(newUser);
  console.log("[USERS] Registered:", newUser);

  res.json({ id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role });
});

// Login
// Body: { email, password }
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  const user = users.find((u) => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const sid = createSession(user.id, user.role);
  // Set cookie so browser sends it automatically later
  res.cookie("sid", sid, { httpOnly: false }); // httpOnly false so you can debug easily

  res.json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// Logout
app.post("/auth/logout", (req, res) => {
  const sid = req.cookies.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie("sid");
  res.json({ ok: true });
});

// Get current user info
app.get("/auth/me", (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.json({ user: null });
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// ---------- ESP32 ENDPOINTS ----------

// Non-moving RFID reader (check-in / book-add)
// ESP32 POSTs: { "tag": "04A1B2..." }
app.post("/esp/checkin", (req, res) => {
  const { tag } = req.body || {};
  if (!tag) {
    console.log("[ESP CHECKIN] Missing tag in body:", req.body);
    return res.status(400).json({ error: "Missing tag" });
  }

  console.log("[ESP CHECKIN] tag:", tag);
  latestCheckinTag = {
    tag,
    seenAt: new Date().toISOString(),
  };

  res.json({ ok: true });
});

// Moving shelf RFID reader
// ESP32 POSTs: { "tag": "04A1B2..." }
app.post("/esp/shelf", (req, res) => {
  const { tag } = req.body || {};
  if (!tag) {
    console.log("[ESP SHELF] Missing tag in body:", req.body);
    return res.status(400).json({ error: "Missing tag" });
  }

  console.log("[ESP SHELF] tag:", tag);

  if (currentScan) {
    currentScan.tags.add(tag);
  }

  res.json({ ok: true });
});

// Motor poll endpoint (ESP32 calls this regularly)
// Expects JSON like: { steps: 4000, stop: false }
app.get("/api/motor", (req, res) => {
  const cmd = pendingMotorCommand;
  res.json(cmd);

  // Clear steps after sending so it doesn't repeat forever
  pendingMotorCommand = { steps: 0, stop: false };
});

// ---------- ADMIN / WEB UI ENDPOINTS ----------

// Stats: total books, total users
app.get("/admin/stats", requireLibrarian, (req, res) => {
  const totalBooks = books.length;
  const totalUsers = users.length;
  res.json({ totalBooks, totalUsers });
});

// Latest tag from check-in reader
app.get("/admin/latest-checkin-tag", requireLibrarian, (req, res) => {
  res.json(latestCheckinTag || { tag: null });
});

// Add a new book
// Body: { tag, title, author }
app.post("/admin/books", requireLibrarian, (req, res) => {
  const { tag, title, author } = req.body || {};
  if (!tag || !title || !author) {
    return res.status(400).json({ error: "tag, title, author are required" });
  }

  const existing = books.find((b) => b.rfid_tag === tag);
  if (existing) {
    // You could update instead; here we just return the existing
    return res.json(existing);
  }

  const newBook = {
    id: books.length + 1,
    title,
    author,
    rfid_tag: tag,
    createdAt: new Date().toISOString(),
  };

  books.push(newBook);
  console.log("[BOOKS] Added:", newBook);

  res.json(newBook);
});

// ----- BORROW / RETURN SYSTEM -----

// Borrow a book
// Body: { userId, bookId }

// List all users (for dropdown)
app.get("/admin/users", requireLibrarian, (req, res) => {
  const slimUsers = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
  }));
  res.json(slimUsers);
});

// List all books (for dropdown)
app.get("/admin/books", requireLibrarian, (req, res) => {
  res.json(books);
});


app.post("/admin/borrow", requireLibrarian, (req, res) => {
  const { userId, bookId } = req.body || {};
  const uid = Number(userId);
  const bid = Number(bookId);

  const user = users.find((u) => u.id === uid);
  const book = books.find((b) => b.id === bid);

  if (!user) return res.status(400).json({ error: "User not found" });
  if (!book) return res.status(400).json({ error: "Book not found" });

  // Check if book already borrowed (loan with no returnedAt)
  const existingLoan = loans.find(
    (l) => l.bookId === bid && l.returnedAt === null
  );
  if (existingLoan) {
    return res.status(400).json({ error: "Book is already borrowed" });
  }

  const newLoan = {
    id: loans.length + 1,
    bookId: bid,
    userId: uid,
    borrowedAt: new Date().toISOString(),
    returnedAt: null,
  };
  loans.push(newLoan);
  console.log("[LOANS] Borrow:", newLoan);

  res.json({
    loan: newLoan,
    book,
    user: { id: user.id, name: user.name, role: user.role },
  });
});

// Return a book
// Body: { bookId } (or { loanId } if you prefer)
app.post("/admin/return", requireLibrarian, (req, res) => {
  const { bookId, loanId } = req.body || {};
  let loan = null;

  if (loanId) {
    const lid = Number(loanId);
    loan = loans.find((l) => l.id === lid && l.returnedAt === null);
  } else if (bookId) {
    const bid = Number(bookId);
    loan = loans.find((l) => l.bookId === bid && l.returnedAt === null);
  }

  if (!loan) {
    return res.status(400).json({ error: "No active loan found for this book" });
  }

  loan.returnedAt = new Date().toISOString();
  console.log("[LOANS] Return:", loan);

  res.json({ loan });
});

// List all loans (with book & user info)
app.get("/admin/loans", requireLibrarian, (req, res) => {
  const result = loans.map((l) => {
    const book = books.find((b) => b.id === l.bookId) || {};
    const user = users.find((u) => u.id === l.userId) || {};
    return {
      id: l.id,
      bookId: l.bookId,
      bookTitle: book.title,
      bookAuthor: book.author,
      rfid_tag: book.rfid_tag,
      userId: l.userId,
      userName: user.name,
      userRole: user.role,
      borrowedAt: l.borrowedAt,
      returnedAt: l.returnedAt,
    };
  });
  res.json(result);
});

// Current user's own loans (for a future student UI)
app.get("/me/loans", requireLogin, (req, res) => {
  const user = req.user;
  const myLoans = loans
    .filter((l) => l.userId === user.id)
    .map((l) => {
      const book = books.find((b) => b.id === l.bookId) || {};
      return {
        id: l.id,
        bookId: l.bookId,
        bookTitle: book.title,
        bookAuthor: book.author,
        rfid_tag: book.rfid_tag,
        borrowedAt: l.borrowedAt,
        returnedAt: l.returnedAt,
      };
    });
  res.json(myLoans);
});

// ----- SHELF SCAN -----

// Start a shelf scan
app.post("/admin/start-shelf-scan", requireLibrarian, (req, res) => {
  currentScan = {
    id: Date.now(),
    tags: new Set(),
    startedAt: new Date().toISOString(),
  };
  console.log("[SCAN] Started scan id:", currentScan.id);

  // Motor movement can be triggered separately via /admin/motor/move
  res.json({ ok: true, scanId: currentScan.id });
});

// End a shelf scan
app.post("/admin/end-shelf-scan", requireLibrarian, (req, res) => {
  if (!currentScan) {
    return res.json({ ok: false, message: "No active scan" });
  }

  currentScan.finishedAt = new Date().toISOString();
  lastCompletedScan = {
    id: currentScan.id,
    startedAt: currentScan.startedAt,
    finishedAt: currentScan.finishedAt,
    tags: Array.from(currentScan.tags),
  };

  console.log("[SCAN] Completed scan id:", lastCompletedScan.id, "tags:", lastCompletedScan.tags);

  currentScan = null;
  res.json({ ok: true });
});

// Get last completed shelf scan + corresponding books
app.get("/admin/last-shelf-scan", requireLibrarian, (req, res) => {
  if (!lastCompletedScan) {
    return res.json({ scan: null, books: [] });
  }

  const tags = lastCompletedScan.tags;
  const matchedBooks = books.filter((b) => tags.includes(b.rfid_tag));

  res.json({
    scan: lastCompletedScan,
    books: matchedBooks,
  });
});

// ----- MOTOR CONTROL FROM WEB -----
app.post("/admin/motor/move", requireLibrarian, (req, res) => {
  const { steps } = req.body || {};
  const n = Number(steps);
  if (!n || Number.isNaN(n) || n === 0) {
    return res.status(400).json({ error: "steps must be non-zero number" });
  }

  pendingMotorCommand = { steps: n, stop: false };
  console.log("[MOTOR] Queued move:", pendingMotorCommand);

  res.json({ ok: true });
});

app.post("/admin/motor/stop", requireLibrarian, (req, res) => {
  pendingMotorCommand = { steps: 0, stop: true };
  console.log("[MOTOR] Queued STOP");

  res.json({ ok: true });
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("Serve librarian panel at /librarian.html");
  console.log("Serve login page at /login.html");
});
