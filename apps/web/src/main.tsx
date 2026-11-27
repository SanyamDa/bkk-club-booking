import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { Details } from './pages/Details';
import { Simulator } from './pages/Simulator';
import { BookingDetail } from './pages/staff/BookingDetail';
import { Handoffs } from './pages/staff/Handoffs';
import { StaffLayout } from './pages/staff/Layout';
import { Login } from './pages/staff/Login';
import { NewBooking } from './pages/staff/NewBooking';
import { Night } from './pages/staff/Night';
import { Settings } from './pages/staff/Settings';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/staff" replace />} />
        <Route path="/liff/details" element={<Details />} />
        <Route path="/dev/simulator" element={<Simulator />} />
        <Route path="/staff/login" element={<Login />} />
        <Route path="/staff" element={<StaffLayout />}>
          <Route index element={<Night />} />
          <Route path="bookings/:id" element={<BookingDetail />} />
          <Route path="handoffs" element={<Handoffs />} />
          <Route path="new" element={<NewBooking />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
