// Import các thư viện cần thiết
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./middleware/auth');
const Groq = require('groq-sdk'); // <--- THÊM IMPORT GROQ

const app = express();
const port = process.env.PORT || 5001;

// ... middleware setup ...
app.use(cors());
app.use(express.json());

// ... database pool setup ...
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// === CÁC API KHÁC (Được giữ nguyên) ===
// 1. API gốc
// ... existing code ...
app.get('/', (req, res) => res.send('Backend server CGV đã chạy thành công!'));
// 2. API Đăng ký
// ... existing code ...
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin.' });
    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password.trim(), salt);
        const newUserQuery = `INSERT INTO Users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id, username, email;`;
        const values = [name.trim(), email.trim().toLowerCase(), password_hash];
        const result = await pool.query(newUserQuery, values);
        res.status(201).json({ message: 'Tạo tài khoản thành công!', user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ message: 'Email hoặc username đã tồn tại.' });
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 3. API Đăng nhập
// ... existing code ...
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp email và mật khẩu.' });
    try {
        const userQuery = 'SELECT * FROM Users WHERE email = $1';
        const result = await pool.query(userQuery, [email.trim().toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password.trim(), user.password_hash);
        if (!isMatch) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const payload = { user: { id: user.user_id, name: user.username, email: user.email } };
        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.status(200).json({ message: 'Đăng nhập thành công!', token: token, user: payload.user });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 4. API Lấy thông tin người dùng
// ... existing code ...
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const userQuery = 'SELECT user_id, username, email, phone, birthday, address, gender FROM Users WHERE user_id = $1';
        const result = await pool.query(userQuery, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
        // Format birthday before sending
        const user = result.rows[0];
        if (user.birthday) {
             user.birthday = new Date(user.birthday).toISOString().split('T')[0]; // Format YYYY-MM-DD
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 5. API Cập nhật thông tin người dùng
// ... existing code ...
app.put('/api/users/me', authMiddleware, async (req, res) => {
    const { name, phone, birthday, address, gender } = req.body;
    try {
        const birthdayValue = birthday ? birthday : null; // Handle null birthday
        const updateUserQuery = `
            UPDATE Users 
            SET username = $1, phone = $2, birthday = $3, address = $4, gender = $5 
            WHERE user_id = $6 
            RETURNING user_id, username, email, phone, birthday, address, gender;
        `;
        const values = [name, phone, birthdayValue, address, gender, req.user.id];
        const result = await pool.query(updateUserQuery, values);
        // Format birthday before sending back
        const updatedUser = result.rows[0];
         if (updatedUser.birthday) {
             updatedUser.birthday = new Date(updatedUser.birthday).toISOString().split('T')[0];
         }
        res.json({ message: 'Cập nhật thông tin thành công!', user: updatedUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 6. API Lấy lịch sử đặt vé (ĐÃ CẬP NHẬT)
// ... existing code ...
app.get('/api/users/me/bookings', authMiddleware, async (req, res) => {
    try {
        const bookingsQuery = `
            SELECT 
                b.booking_id, 
                m.title AS movie_title, 
                m.poster_url,
                m.genre,
                c.name AS cinema_name, 
                s.start_time, 
                b.total_amount,
                b.seats 
            FROM Bookings b 
            JOIN Showtimes s ON b.showtime_id = s.showtime_id 
            JOIN Movies m ON s.movie_id = m.movie_id
            JOIN Cinemas c ON s.cinema_id = c.cinema_id 
            WHERE b.user_id = $1 
            ORDER BY s.start_time DESC;
        `;
        const result = await pool.query(bookingsQuery, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get bookings:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 7. API Lấy danh sách phim (Phiên bản đã sửa lỗi)
// ... existing code ...
app.get('/api/movies', async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM Movies ORDER BY release_date DESC';
        
        if (status === 'now-showing') {
            query = "SELECT * FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY release_date DESC";
        } else if (status === 'coming-soon') {
            query = "SELECT * FROM Movies WHERE release_date > CURRENT_DATE ORDER BY release_date ASC";
        }
        
        const result = await pool.query(query);
        // Chuyển đổi định dạng ngày tháng ở phía server trước khi gửi đi
        const movies = result.rows.map(movie => ({
            ...movie,
            // Đảm bảo chỉ chuyển đổi nếu release_date không null
            release_date: movie.release_date ? movie.release_date.toISOString().split('T')[0] : null
        }));

        res.json(movies);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 8. API Lấy danh sách thành phố (Đã sửa để trả về count)
// ... existing code ...
app.get('/api/cinemas/cities', async (req, res) => {
    try {
        const query = 'SELECT city, COUNT(cinema_id)::text as count FROM Cinemas GROUP BY city ORDER BY city'; // Cast count to text
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get cities:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});
// 9. API Lấy danh sách rạp phim
// ... existing code ...
app.get('/api/cinemas', async (req, res) => {
    try {
        const { city } = req.query;
        let query = 'SELECT * FROM Cinemas ORDER BY name';
        let values = [];
        if (city && city !== 'all') {
            query = 'SELECT * FROM Cinemas WHERE city = $1 ORDER BY name';
            values.push(city);
        }
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// === API CHATBOT "AGENT" THÔNG MINH HƠN ===
// ... existing code ...
app.post('/api/chat', authMiddleware, async (req, res) => {
    const { message, history } = req.body;
    const userId = req.user.id;

    if (!message) {
        return res.status(400).json({ message: 'Tin nhắn không được để trống.' });
    }

    try {
        // --- BƯỚC 1: THU THẬP TOÀN BỘ CONTEXT ---

        // 1.1. Lịch sử xem phim của người dùng
        const historyQuery = `SELECT m.title, m.genre FROM Bookings b JOIN Showtimes s ON b.showtime_id = s.showtime_id JOIN Movies m ON s.movie_id = m.movie_id WHERE b.user_id = $1 ORDER BY b.booking_time DESC LIMIT 5;`;
        const historyResult = await pool.query(historyQuery, [userId]);
        const userViewingHistory = historyResult.rows.length > 0
            ? `Người dùng này đã xem các phim sau: ${historyResult.rows.map(r => `${r.title} (${r.genre})`).join(', ')}.`
            : "Người dùng này chưa có lịch sử xem phim.";

        // 1.2. Danh sách phim hiện có trong rạp
        const moviesQuery = "SELECT title, genre, description FROM Movies WHERE release_date <= CURRENT_DATE";
        const moviesResult = await pool.query(moviesQuery);
        const availableMovies = moviesResult.rows.map(m => `- ${m.title} (Thể loại: ${m.genre})`).join('\n');

        // 1.3. Lịch sử cuộc trò chuyện hiện tại
        const conversationHistory = history ? history.map(msg => `${msg.sender === 'user' ? 'Người dùng' : 'Bot'}: ${msg.text}`).join('\n') : '';

        // --- BƯỚC 2: TẠO "SIÊU PROMPT" (MASTER PROMPT) ---
        const systemPrompt = `
        Bạn là "CGV-Bot", một trợ lý AI chuyên nghiệp và thân thiện của rạp phim CGV.
        
        **NHIỆM VỤ CỐT LÕI CỦA BẠN:**
        1.  **Hiểu và tiếp nối cuộc trò chuyện:** Dựa vào "Lịch sử cuộc trò chuyện" để hiểu ngữ cảnh. Nếu người dùng nói "có" hoặc "tiếp đi", hãy hiểu rằng họ đang đồng ý với câu hỏi ngay trước đó của bạn.
        2.  **Đưa ra gợi ý cá nhân hóa:** Dựa vào "Lịch sử xem phim của người dùng" để đưa ra gợi ý phù hợp.
        3.  **Bám sát thực tế:** Khi gợi ý phim, bạn **CHỈ ĐƯỢC PHÉP** chọn từ "Danh sách phim hiện có tại rạp". Không được tự sáng tạo ra phim khác.
        4.  **Luôn trả lời bằng tiếng Việt**, sử dụng định dạng **Markdown** (in đậm, danh sách, xuống dòng) và thêm các emoji 🍿🎬🎟️ để câu trả lời sinh động.

        **CONTEXT ĐƯỢC CUNG CẤP:**
        
        1. **Về người dùng:**
           - ${userViewingHistory}

        2. **Danh sách phim hiện có tại rạp:**
           ${availableMovies}

        3. **Lịch sử cuộc trò chuyện:**
           ${conversationHistory}

        **YÊU CẦU:** Bây giờ, hãy đọc tin nhắn cuối cùng của người dùng và tạo ra câu trả lời tiếp theo một cách thông minh và tự nhiên nhất.
        `;

        // --- BƯỚC 3: GỌI GROQ API VỚI PROMPT DUY NHẤT ---
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ],
            model: "llama-3.1-8b-instant",
        });

        const reply = chatCompletion.choices[0]?.message?.content || "Xin lỗi, tôi chưa thể trả lời câu hỏi này.";
        res.json({ reply });

    } catch (err) {
        console.error("Lỗi API Chat:", err);
        res.status(500).json({ message: 'Lỗi server khi xử lý yêu cầu chat.' });
    }
});

// 11. API để lấy thông tin chi tiết của một phim
// ... existing code ...
app.get('/api/movies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = "SELECT *, to_char(release_date, 'YYYY-MM-DD') as release_date FROM Movies WHERE movie_id = $1";
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phim.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 12. API để lấy suất chiếu của một phim (Đã cập nhật để bao gồm thành phố)
// ... existing code ...
app.get('/api/movies/:id/showtimes', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                s.showtime_id,
                s.start_time,
                s.ticket_price,
                c.name as cinema_name,
                c.city
            FROM Showtimes s
            JOIN Cinemas c ON s.cinema_id = c.cinema_id
            WHERE s.movie_id = $1 AND s.start_time > NOW() 
            ORDER BY c.city, c.name, s.start_time;
        `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy suất chiếu cho phim:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// --- XÓA ĐỊNH NGHĨA API /api/bookings CŨ ---
// app.post('/api/bookings', authMiddleware, async (req, res) => { ... });

// 13. API để tạo một booking mới (PHIÊN BẢN CÓ TRANSACTION - ĐÃ SỬA LỖI)
app.post('/api/bookings', authMiddleware, async (req, res) => {
    const { showtime_id, seats } = req.body; // `seats` là một mảng, ví dụ: ['H8', 'H9']
    const userId = req.user.id;

    if (!showtime_id || !seats || !Array.isArray(seats) || seats.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin suất chiếu và ghế ngồi.' });
    }

    const client = await pool.connect();

    try {
        // BẮT ĐẦU TRANSACTION
        await client.query('BEGIN');

        // 1. Kiểm tra xem có ghế nào đã được đặt chưa (Sử dụng FOR UPDATE để khóa dòng)
        const checkSeatsQuery = `SELECT seat_id FROM booked_seats WHERE showtime_id = $1 AND seat_id = ANY($2::text[]) FOR UPDATE`;
        const existingSeatsResult = await client.query(checkSeatsQuery, [showtime_id, seats]);

        if (existingSeatsResult.rows.length > 0) {
            const occupied = existingSeatsResult.rows.map(r => r.seat_id).join(', ');
            // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 409
            await client.query('ROLLBACK'); // Hủy transaction
            return res.status(409).json({ message: `Ghế ${occupied} đã có người đặt. Vui lòng chọn ghế khác.` });
        }

        // 2. Lấy giá vé và tính tổng tiền
        const showtimeQuery = 'SELECT ticket_price FROM showtimes WHERE showtime_id = $1';
        const showtimeResult = await client.query(showtimeQuery, [showtime_id]);
        if (showtimeResult.rows.length === 0) {
             // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 404
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Không tìm thấy suất chiếu.' });
        }
        const ticketPrice = parseFloat(showtimeResult.rows[0].ticket_price);
        const totalAmount = ticketPrice * seats.length;

        // 3. Tạo một bản ghi mới trong bảng `bookings` với cột `seats`
        const newBookingQuery = `
            INSERT INTO bookings (user_id, showtime_id, total_amount, seats)
            VALUES ($1, $2, $3, $4)
            RETURNING booking_id;
        `;
        const bookingValues = [userId, showtime_id, totalAmount, seats];
        const bookingResult = await client.query(newBookingQuery, bookingValues);
        const newBookingId = bookingResult.rows[0].booking_id;

        // 4. Thêm từng ghế đã đặt vào bảng `booked_seats`
        // (Sử dụng vòng lặp for...of để đảm bảo tuần tự)
        for (const seat_id of seats) {
            const bookSeatQuery = `
                INSERT INTO booked_seats (booking_id, showtime_id, seat_id)
                VALUES ($1, $2, $3);
            `;
            await client.query(bookSeatQuery, [newBookingId, showtime_id, seat_id]);
        }
        
        // 5. Cập nhật lại số ghế trống trong bảng `showtimes`
        const updateShowtimeQuery = `
            UPDATE showtimes 
            SET available_seats = available_seats - $1 
            WHERE showtime_id = $2;
        `;
        await client.query(updateShowtimeQuery, [seats.length, showtime_id]);

        // KẾT THÚC TRANSACTION, LƯU TẤT CẢ THAY ĐỔI
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Đặt vé thành công!',
            bookingId: newBookingId,
        });

    } catch (err) {
        // Nếu có bất kỳ lỗi nào khác (ngoài lỗi đã xử lý ở trên), hủy bỏ tất cả thay đổi
        await client.query('ROLLBACK');
        console.error("Lỗi khi tạo booking:", err);
        // Gửi thông báo lỗi server chung chung
        res.status(500).json({ message: 'Lỗi server khi đặt vé.' });
    } finally {
        // Luôn giải phóng kết nối sau khi hoàn tất
        client.release();
    }
});

// API 15: Lấy danh sách khuyến mãi
// ... existing code ...
app.get('/api/promotions', async (req, res) => {
    try {
        const query = 'SELECT *, to_char(valid_until, \'YYYY-MM-DD\') as valid_until FROM Promotions ORDER BY featured DESC, valid_until ASC';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách khuyến mãi:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 16: Lấy danh sách sự kiện (ĐÃ SỬA LỖI)
// ... existing code ...
app.get('/api/events', async (req, res) => {
    try {
        const query = `
            SELECT 
                *, 
                to_char(event_date, 'YYYY-MM-DD') as event_date 
            FROM Events 
            WHERE event_date > NOW() 
            ORDER BY Events.event_date ASC`; 
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách sự kiện:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 17: Lấy lịch chiếu tổng hợp cho một rạp vào một ngày
// ... existing code ...
app.get('/api/showtimes-by-cinema', async (req, res) => {
    const { cinemaId, date } = req.query; // date có định dạng YYYY-MM-DD

    if (!cinemaId || !date) {
        return res.status(400).json({ message: 'Vui lòng cung cấp cinemaId và date.' });
    }

    try {
        const query = `
            SELECT
                m.movie_id, m.title, m.genre, m.duration_minutes, m.rating, m.age_rating, m.poster_url, m.features,
                json_agg(
                    json_build_object(
                        'showtime_id', s.showtime_id,
                        'start_time', s.start_time,
                        'ticket_price', s.ticket_price
                    ) ORDER BY s.start_time
                ) AS times
            FROM Movies m
            JOIN Showtimes s ON m.movie_id = s.movie_id
            WHERE s.cinema_id = $1 
              AND s.start_time >= ($2::date) 
              AND s.start_time < ($2::date + interval '1 day')
              AND s.start_time > NOW()
            GROUP BY m.movie_id
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [cinemaId, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi khi lấy lịch chiếu theo rạp:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 18: Lấy danh sách các ghế đã bị chiếm cho một suất chiếu cụ thể
// ... existing code ...
app.get('/api/showtimes/:showtimeId/occupied-seats', async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const query = 'SELECT seat_id FROM booked_seats WHERE showtime_id = $1';
        const result = await pool.query(query, [showtimeId]);
        res.json(result.rows.map(row => row.seat_id));
    } catch (err) {
        console.error('Lỗi khi lấy danh sách ghế đã chiếm:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API MỚI: Đặt vé sự kiện
app.post('/api/events/bookings', authMiddleware, async(req, res) => {
     const { event_id, number_of_tickets, total_amount } = req.body;
     const userId = req.user.id;

     if (!event_id || !number_of_tickets || number_of_tickets <= 0 || !total_amount) {
         return res.status(400).json({ message: 'Thông tin đặt vé sự kiện không hợp lệ.' });
     }

     const client = await pool.connect();
     try {
         await client.query('BEGIN');

         // (Tùy chọn) Kiểm tra số lượng vé còn lại của sự kiện nếu có
         // const eventQuery = 'SELECT available_tickets FROM Events WHERE event_id = $1 FOR UPDATE';
         // const eventResult = await client.query(eventQuery, [event_id]);
         // if (eventResult.rows.length === 0) throw new Error('Không tìm thấy sự kiện.');
         // const availableTickets = eventResult.rows[0].available_tickets;
         // if (availableTickets < number_of_tickets) throw new Error('Không đủ vé sự kiện.');

         // Tạo booking sự kiện
         const insertBookingQuery = `
            INSERT INTO event_bookings (user_id, event_id, number_of_tickets, total_amount) 
            VALUES ($1, $2, $3, $4) 
            RETURNING event_booking_id;
         `;
         const bookingResult = await client.query(insertBookingQuery, [userId, event_id, number_of_tickets, total_amount]);
         const newBookingId = bookingResult.rows[0].event_booking_id;

         // (Tùy chọn) Cập nhật số lượng vé còn lại
         // const updateEventQuery = 'UPDATE Events SET available_tickets = available_tickets - $1 WHERE event_id = $2';
         // await client.query(updateEventQuery, [number_of_tickets, event_id]);

         await client.query('COMMIT');
         res.status(201).json({ message: 'Đặt vé sự kiện thành công!', bookingId: newBookingId });

     } catch (err) {
         await client.query('ROLLBACK');
         console.error("Lỗi khi đặt vé sự kiện:", err);
         res.status(500).json({ message: err.message || 'Lỗi server khi đặt vé sự kiện.' });
     } finally {
         client.release();
     }
});


// Lắng nghe server
// ... existing code ...
app.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}`);
});
