export type Lang = 'en' | 'th';

export function langOf(code: string | null | undefined): Lang {
  return code?.toLowerCase().startsWith('th') ? 'th' : 'en';
}

type Vars = Record<string, string | number>;

const strings = {
  bookTable: { en: 'Book a table', th: 'จองโต๊ะ' },
  myBooking: { en: 'My booking', th: 'การจองของฉัน' },
  talkToHost: { en: 'Talk to a host', th: 'คุยกับพนักงาน' },
  location: { en: 'Location', th: 'แผนที่' },
  drinksMenu: { en: 'Drinks menu', th: 'เมนูเครื่องดื่ม' },
  menuPrompt: { en: 'I can help you with:', th: 'เลือกสิ่งที่ต้องการได้เลย:' },

  askNight: { en: 'Which night would you like to book?', th: 'ต้องการจองคืนไหนคะ?' },
  pickDate: { en: 'Pick a date', th: 'เลือกวันที่' },
  tonight: { en: 'Tonight', th: 'คืนนี้' },
  noNights: {
    en: 'We’re not taking bookings online right now. A host can help you.',
    th: 'ขณะนี้ยังไม่เปิดจองออนไลน์ พนักงานยินดีช่วยค่ะ',
  },
  nightClosed: {
    en: 'Sorry, we can’t take bookings for {night}. Please pick another night.',
    th: 'ขออภัย ไม่สามารถจองคืน {night} ได้ กรุณาเลือกคืนอื่นค่ะ',
  },
  askPax: { en: 'How many guests? ({night})', th: 'มากี่ท่านคะ? ({night})' },
  bigGroup: {
    en: 'For groups of 13 or more, a host will arrange it with you personally.',
    th: 'สำหรับกลุ่ม 13 ท่านขึ้นไป พนักงานจะติดต่อจัดการให้โดยตรงค่ะ',
  },
  tablesIntro: {
    en: 'Free tables for {night}, {pax} guests. Swipe to see them all.',
    th: 'โต๊ะว่างคืน {night} สำหรับ {pax} ท่าน เลื่อนดูได้เลยค่ะ',
  },
  noTables: {
    en: 'No tables left for {night} that fit {pax} guests.',
    th: 'ไม่มีโต๊ะว่างสำหรับ {pax} ท่านในคืน {night} แล้วค่ะ',
  },
  otherNight: { en: 'Another night', th: 'คืนอื่น' },
  chooseTable: { en: 'Choose {code}', th: 'เลือก {code}' },
  guestsRange: { en: '{min}–{max} guests', th: '{min}–{max} ท่าน' },
  minSpend: { en: 'Minimum spend', th: 'ยอดขั้นต่ำ' },
  deposit: { en: 'Deposit', th: 'มัดจำ' },
  noDeposit: { en: 'No deposit', th: 'ไม่ต้องมัดจำ' },
  tableTaken: {
    en: 'Someone just booked {code}. Here are the tables still free:',
    th: 'โต๊ะ {code} เพิ่งถูกจองไปค่ะ นี่คือโต๊ะที่ยังว่าง:',
  },

  held: {
    en: '{code} is held for you until {time}. Add your details to continue.',
    th: 'จองโต๊ะ {code} ไว้ให้ถึง {time} น. กรุณากรอกข้อมูลเพื่อดำเนินการต่อค่ะ',
  },
  enterDetails: { en: 'Enter my details', th: 'กรอกข้อมูล' },
  detailsSentText: { en: 'Details sent · {ref}', th: 'ส่งข้อมูลแล้ว · {ref}' },

  reviewTitle: { en: 'Review your booking', th: 'ตรวจสอบการจอง' },
  arriveBy: { en: 'Arrive by {time} or the table may be released', th: 'กรุณามาถึงก่อน {time} น. มิฉะนั้นอาจปล่อยโต๊ะค่ะ' },
  rulesAccepted: { en: 'House rules accepted', th: 'ยอมรับกฎของร้านแล้ว' },
  confirmPay: { en: 'Confirm & pay deposit', th: 'ยืนยันและชำระมัดจำ' },
  confirmNoDeposit: { en: 'Confirm booking', th: 'ยืนยันการจอง' },
  change: { en: 'Change', th: 'เปลี่ยน' },

  payTitle: { en: 'Pay your deposit', th: 'ชำระเงินมัดจำ' },
  payInstructions: {
    en: 'Scan with any Thai banking app and pay exactly {amount} to {name}.\nThen send the payment slip here in this chat.\nRef {ref} · held until {time}',
    th: 'สแกนด้วยแอปธนาคาร และโอน {amount} พอดี ให้ {name}\nจากนั้นส่งสลิปในแชทนี้ได้เลยค่ะ\nรหัส {ref} · จองไว้ถึง {time} น.',
  },
  payDemo: {
    en: 'DEMO MODE: no real payment. Send any image here as your "slip" and a host will approve it.\nAmount {amount} · Ref {ref} · held until {time}',
    th: 'โหมดทดลอง: ไม่ต้องโอนจริง ส่งรูปภาพใดก็ได้เป็น "สลิป" แล้วพนักงานจะอนุมัติค่ะ\nยอด {amount} · รหัส {ref} · จองไว้ถึง {time} น.',
  },
  slipReceived: {
    en: 'Thanks, we’re checking your payment. You’ll get your confirmation here shortly.',
    th: 'ขอบคุณค่ะ กำลังตรวจสอบการชำระเงิน จะแจ้งยืนยันในแชทนี้เร็วๆ นี้ค่ะ',
  },
  slipTableLost: {
    en: 'Thanks for your payment. Your hold had expired and the table was taken, so a host will contact you here to sort it out.',
    th: 'ขอบคุณสำหรับการชำระเงิน การจองหมดเวลาและโต๊ะถูกจองไปแล้ว พนักงานจะติดต่อกลับในแชทนี้ค่ะ',
  },
  holdExpired: {
    en: 'Your hold on {code} for {night} has expired.',
    th: 'การจองโต๊ะ {code} คืน {night} หมดเวลาแล้วค่ะ',
  },
  tryAgain: { en: 'Book again', th: 'จองอีกครั้ง' },
  holdExpiredOnConfirm: {
    en: 'Sorry, your hold expired before you confirmed. Let’s pick again.',
    th: 'ขออภัย การจองหมดเวลาก่อนยืนยัน กรุณาเลือกใหม่อีกครั้งค่ะ',
  },

  confirmedTitle: { en: 'You’re booked', th: 'จองสำเร็จแล้ว' },
  showAtDoor: { en: 'Show this QR at the door with your ID', th: 'แสดง QR นี้พร้อมบัตรประชาชนที่หน้าร้าน' },
  depositPaid: { en: 'Deposit paid', th: 'ชำระมัดจำแล้ว' },
  remaining: { en: 'Remaining minimum spend', th: 'ยอดขั้นต่ำคงเหลือ' },
  guests: { en: 'Guests', th: 'จำนวน' },
  table: { en: 'Table', th: 'โต๊ะ' },
  night: { en: 'Night', th: 'คืน' },
  paymentRejected: {
    en: 'We couldn’t verify your payment for {ref}. A host will contact you here.',
    th: 'ไม่สามารถยืนยันการชำระเงินของ {ref} ได้ พนักงานจะติดต่อกลับในแชทนี้ค่ะ',
  },
  cancelledByClub: {
    en: 'Your booking {ref} for {night} has been cancelled. {reason}',
    th: 'การจอง {ref} คืน {night} ถูกยกเลิกแล้ว {reason}',
  },

  inProgress: {
    en: 'You were booking {code} for {night}.',
    th: 'คุณกำลังจองโต๊ะ {code} คืน {night} อยู่ค่ะ',
  },
  continueBooking: { en: 'Continue', th: 'ทำต่อ' },
  startOver: { en: 'Start over', th: 'เริ่มใหม่' },
  alreadyBooked: {
    en: 'You already have a booking: {code} on {night} ({status}).',
    th: 'คุณมีการจองอยู่แล้ว: โต๊ะ {code} คืน {night} ({status})',
  },
  noBooking: { en: 'You don’t have an upcoming booking.', th: 'คุณยังไม่มีการจองค่ะ' },
  status_held: { en: 'held, details needed', th: 'รอกรอกข้อมูล' },
  status_awaiting_payment: { en: 'waiting for deposit', th: 'รอชำระมัดจำ' },
  status_payment_review: { en: 'checking payment', th: 'กำลังตรวจสอบการชำระเงิน' },
  status_confirmed: { en: 'confirmed', th: 'ยืนยันแล้ว' },

  handoffAck: {
    en: 'Got it, a host will reply here shortly.',
    th: 'รับทราบค่ะ พนักงานจะตอบกลับในแชทนี้เร็วๆ นี้ค่ะ',
  },
  slipWithoutBooking: {
    en: 'Thanks for the image. If it’s a payment slip, please start a booking first, or talk to a host.',
    th: 'ขอบคุณสำหรับรูปภาพค่ะ หากเป็นสลิปโอนเงิน กรุณาเริ่มจองก่อน หรือคุยกับพนักงานค่ะ',
  },

  // B10: reminder, running late, guest cancel
  reminder: {
    en: 'See you tonight. Table {code}, please arrive by {time}.',
    th: 'แล้วพบกันคืนนี้ค่ะ โต๊ะ {code} กรุณามาถึงก่อน {time} น.',
  },
  runningLate: { en: 'Running late', th: 'มาสาย' },
  needToCancel: { en: 'Need to cancel', th: 'ต้องการยกเลิก' },
  cancelShort: { en: 'Cancel', th: 'ยกเลิก' },
  askLate: { en: 'How late will you be?', th: 'จะมาสายประมาณเท่าไรคะ?' },
  late15: { en: '15 min', th: '15 นาที' },
  late30: { en: '30 min', th: '30 นาที' },
  late60: { en: '1 hr', th: '1 ชม.' },
  lateNoted: {
    en: 'Thanks for letting us know. We’ve told the host and will hold {code} until {time}.',
    th: 'ขอบคุณที่แจ้งค่ะ เราแจ้งพนักงานแล้ว และจะเก็บโต๊ะ {code} ไว้ให้ถึง {time} น.',
  },
  cancelAsk: {
    en: 'Cancel {code} on {night}?\n{policy}',
    th: 'ต้องการยกเลิกโต๊ะ {code} คืน {night} ใช่ไหมคะ?\n{policy}',
  },
  cancelYes: { en: 'Yes, cancel', th: 'ใช่ ยกเลิก' },
  keepBooking: { en: 'Keep booking', th: 'เก็บการจองไว้' },
  cancelledByGuest: {
    en: 'Your booking {ref} for {night} is cancelled.',
    th: 'ยกเลิกการจอง {ref} คืน {night} แล้วค่ะ',
  },
  cannotChangeBooking: {
    en: 'This booking can’t be changed here any more. A host can help.',
    th: 'ไม่สามารถเปลี่ยนแปลงการจองนี้ในแชทได้แล้ว พนักงานยินดีช่วยค่ะ',
  },
} satisfies Record<string, Record<Lang, string>>;

export type StringKey = keyof typeof strings;

export function t(lang: Lang, key: StringKey, vars: Vars = {}): string {
  let s: string = strings[key][lang];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
