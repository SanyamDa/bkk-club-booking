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
import { AdminLayout } from './pages/admin/AdminLayout';
import { ClubDetail } from './pages/admin/ClubDetail';
import { Clubs } from './pages/admin/Clubs';
import { Controls } from './pages/admin/Controls';
import { DataHealth } from './pages/admin/DataHealth';
import { EventStream } from './pages/admin/EventStream';
import { LineWizard } from './pages/admin/LineWizard';
import { MessageLog } from './pages/admin/MessageLog';
import { Timeline } from './pages/admin/Timeline';
import { WebhookLog } from './pages/admin/WebhookLog';

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
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Clubs />} />
          <Route path="clubs/:slug" element={<ClubDetail />} />
          <Route path="clubs/:slug/line" element={<LineWizard />} />
          <Route path="clubs/:slug/webhooks" element={<WebhookLog />} />
          <Route path="clubs/:slug/messages" element={<MessageLog />} />
          <Route path="clubs/:slug/conversations/:id" element={<Timeline kind="conversations" />} />
          <Route path="clubs/:slug/bookings/:id" element={<Timeline kind="bookings" />} />
          <Route path="controls" element={<Controls />} />
          <Route path="data" element={<DataHealth />} />
          <Route path="events" element={<EventStream />} />
        </Route>
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
