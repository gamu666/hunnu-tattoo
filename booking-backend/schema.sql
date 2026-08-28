CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  artist TEXT,
  booking_date TEXT NOT NULL,
  booking_time TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  merchant_route TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  invoice_id TEXT,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'website',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS active_booking_slot
ON bookings(artist, booking_date, booking_time)
WHERE status IN ('pending', 'pending_payment', 'paid', 'confirmed');

CREATE TABLE IF NOT EXISTS reminder_log (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
