const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3003;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://admin:password123@mongodb:27017/ticketbooking?authSource=admin';
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL || 'http://ticket-service:3002';

// Middleware
app.use(cors());
app.use(express.json());

// Booking Schema
const bookingSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    username: { type: String, required: true },
    ticketId: { type: String, required: true },
    eventName: { type: String, required: true },
    venue: String,
    eventDate: Date,
    eventTime: String,
    quantity: { type: Number, required: true, min: 1 },
    totalPrice: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'cancelled'],
        default: 'pending'
    },
    bookingReference: { type: String, unique: true },
    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending'
    },
    contactEmail: String,
    contactPhone: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Generate booking reference
function generateBookingReference() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 7);
    return `BK-${timestamp}-${random}`.toUpperCase();
}

// Routes
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'booking-service' });
});

// Create booking
app.post('/api/bookings', async (req, res) => {
    try {
        const { userId, username, ticketId, quantity, contactEmail, contactPhone } = req.body;

        if (!userId || !username || !ticketId || !quantity) {
            return res.status(400).json({
                error: 'userId, username, ticketId, and quantity are required'
            });
        }

        // Get ticket details from ticket service
        let ticketResponse;
        try {
            ticketResponse = await axios.get(`${TICKET_SERVICE_URL}/api/tickets/${ticketId}`);
        } catch (error) {
            console.error('Error fetching ticket:', error.message);
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const ticket = ticketResponse.data;

        // Check availability
        if (ticket.availableSeats < quantity) {
            return res.status(400).json({ error: 'Not enough seats available' });
        }

        // Reserve seats
        try {
            await axios.post(`${TICKET_SERVICE_URL}/api/tickets/${ticketId}/reserve`, {
                quantity
            });
        } catch (error) {
            console.error('Error reserving seats:', error.message);
            return res.status(500).json({ error: 'Error reserving seats' });
        }

        // Create booking
        const booking = new Booking({
            userId,
            username,
            ticketId,
            eventName: ticket.eventName,
            venue: ticket.venue,
            eventDate: ticket.date,
            eventTime: ticket.time,
            quantity,
            totalPrice: ticket.price * quantity,
            bookingReference: generateBookingReference(),
            status: 'confirmed',
            paymentStatus: 'completed', // Simplified - in real app would integrate payment gateway
            contactEmail,
            contactPhone
        });

        await booking.save();

        res.status(201).json({
            message: 'Booking created successfully',
            booking
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Error creating booking' });
    }
});

// Get all bookings for a user
app.get('/api/bookings', async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const bookings = await Booking.find({ userId }).sort({ createdAt: -1 });
        res.json(bookings);
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Error fetching bookings' });
    }
});

// Get booking by ID
app.get('/api/bookings/:id', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(booking);
    } catch (error) {
        console.error('Error fetching booking:', error);
        res.status(500).json({ error: 'Error fetching booking' });
    }
});

// Get booking by reference
app.get('/api/bookings/reference/:reference', async (req, res) => {
    try {
        const booking = await Booking.findOne({ bookingReference: req.params.reference });
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(booking);
    } catch (error) {
        console.error('Error fetching booking:', error);
        res.status(500).json({ error: 'Error fetching booking' });
    }
});

// Cancel booking
app.delete('/api/bookings/:id', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        if (booking.status === 'cancelled') {
            return res.status(400).json({ error: 'Booking already cancelled' });
        }

        // Release seats back to ticket service
        try {
            await axios.post(`${TICKET_SERVICE_URL}/api/tickets/${booking.ticketId}/release`, {
                quantity: booking.quantity
            });
        } catch (error) {
            console.error('Error releasing seats:', error.message);
            // Continue with cancellation even if release fails
        }

        // Update booking status
        booking.status = 'cancelled';
        booking.paymentStatus = 'refunded';
        booking.updatedAt = new Date();
        await booking.save();

        res.json({
            message: 'Booking cancelled successfully',
            booking
        });
    } catch (error) {
        console.error('Error cancelling booking:', error);
        res.status(500).json({ error: 'Error cancelling booking' });
    }
});

// Get booking statistics (for admin)
app.get('/api/bookings/stats/summary', async (req, res) => {
    try {
        const totalBookings = await Booking.countDocuments();
        const confirmedBookings = await Booking.countDocuments({ status: 'confirmed' });
        const cancelledBookings = await Booking.countDocuments({ status: 'cancelled' });

        const revenueResult = await Booking.aggregate([
            { $match: { status: 'confirmed', paymentStatus: 'completed' } },
            { $group: { _id: null, total: { $sum: '$totalPrice' } } }
        ]);

        const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

        res.json({
            totalBookings,
            confirmedBookings,
            cancelledBookings,
            totalRevenue
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Error fetching statistics' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Booking service running on port ${PORT}`);
});
