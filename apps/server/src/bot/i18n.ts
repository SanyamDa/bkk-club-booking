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
  payNow: { en: 'Pay deposit', th: 'ชำระมัดจำ' },
  payLinkInstructions: {
    en: 'Tap the button to pay {amount} by PromptPay or card. Your confirmation arrives here once it goes through.\nRef {ref} · held until {time}',
    th: 'กดปุ่มเพื่อชำระ {amount} ผ่านพร้อมเพย์หรือบัตร เมื่อชำระสำเร็จจะได้รับการยืนยันในแชทนี้ค่ะ\nรหัส {ref} · จองไว้ถึง {time} น.',
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
  // Spec §7.2: max active bookings per guest per night.
  bookOtherNight: { en: 'Book another night', th: 'จองคืนอื่น' },
  // Spec §5.2 step 3.
  seeFloorPlan: { en: 'See floor plan', th: 'ดูผังร้าน' },
  nightLimit: {
    en: 'You already have a booking on {night}. Please pick another night.',
    th: 'คุณมีการจองคืน {night} อยู่แล้ว กรุณาเลือกคืนอื่น',
  },
  status_held: { en: 'held, details needed', th: 'รอกรอกข้อมูล' },
  status_awaiting_payment: { en: 'waiting for deposit', th: 'รอชำระมัดจำ' },
  status_payment_review: { en: 'checking payment', th: 'กำลังตรวจสอบการชำระเงิน' },
  status_confirmed: { en: 'confirmed', th: 'ยืนยันแล้ว' },

  handoffAck: {
    en: 'Got it, a host will reply here shortly.',
    th: 'รับทราบค่ะ พนักงานจะตอบกลับในแชทนี้เร็วๆ นี้ค่ะ',
  },
  /** §5.3: the handoff reply outside the club's host hours. */
  handoffAckOffHours: {
    en: 'Got it, a host will reply here. Our hosts are online from {from}.',
    th: 'รับทราบค่ะ พนักงานจะตอบกลับในแชทนี้ พนักงานของเราออนไลน์ตั้งแต่ {from} น. ค่ะ',
  },
  slipWithoutBooking: {
    en: 'Thanks for the image. If it’s a payment slip, please start a booking first, or talk to a host.',
    th: 'ขอบคุณสำหรับรูปภาพค่ะ หากเป็นสลิปโอนเงิน กรุณาเริ่มจองก่อน หรือคุยกับพนักงานค่ะ',
  },

  // §5.2 step 10: the optional next-day message.
  afterVisit: {
    en: 'Thanks for coming to {club} last night. We hope to see you again soon.',
    th: 'ขอบคุณที่มาเที่ยว {club} เมื่อคืนนะคะ หวังว่าจะได้พบกันอีกเร็วๆ นี้ค่ะ',
  },
  bookAgain: { en: 'Book again', th: 'จองอีกครั้ง' },
  // B10: reminder, running late, guest cancel
  reminder: {
    en: 'See you tonight. Table {code}, please arrive by {time}.',
    th: 'แล้วพบกันคืนนี้ค่ะ โต๊ะ {code} กรุณามาถึงก่อน {time} น.',
  },
  runningLate: { en: 'Running late', th: 'มาสาย' },
  needToCancel: { en: 'Need to cancel', th: 'ต้องการยกเลิก' },
  cancelShort: { en: 'Cancel', th: 'ยกเลิก' },
  // §5.3: [Change party size] on My booking.
  changePax: { en: 'Change party size', th: 'เปลี่ยนจำนวนคน' },
  askPaxChange: { en: 'How many guests now? Table {code} seats {min}–{max}.', th: 'ตอนนี้มากี่ท่านคะ? โต๊ะ {code} นั่งได้ {min}–{max} ท่าน' },
  paxChanged: { en: 'Done: {code} on {night} is now for {pax} guests.', th: 'เรียบร้อยค่ะ โต๊ะ {code} คืน {night} เปลี่ยนเป็น {pax} ท่านแล้วค่ะ' },
  paxTooMany: {
    en: 'Table {code} seats up to {max}. For a bigger group, a host can move you to another table.',
    th: 'โต๊ะ {code} นั่งได้สูงสุด {max} ท่าน หากมากกว่านี้ พนักงานช่วยย้ายโต๊ะให้ได้ค่ะ',
  },
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

  // B10b: data removal and marketing opt-out (spec §14.9, §5.5).
  myData: { en: 'My data', th: 'ข้อมูลของฉัน' },
  // Spec §5.3: the language switch in the menu, labelled in the language it switches to.
  switchLang: { en: 'ภาษาไทย', th: 'English' },
  myDataPrompt: {
    en: 'You can stop promotional messages, or ask us to remove your data.',
    th: 'คุณสามารถหยุดรับข้อความโปรโมชัน หรือขอให้เราลบข้อมูลของคุณได้ค่ะ',
  },
  stopPromotions: { en: 'Stop promotions', th: 'หยุดรับโปรโมชัน' },
  removeMyData: { en: 'Remove my data', th: 'ลบข้อมูลของฉัน' },
  removeConfirmPrompt: {
    en: 'Remove your data? We will delete your chats, payment slips and contact details. Booking counts stay, without your name.',
    th: 'ต้องการลบข้อมูลของคุณหรือไม่คะ? เราจะลบแชท สลิปโอนเงิน และข้อมูลติดต่อของคุณ ยอดจำนวนการจองยังคงอยู่โดยไม่มีชื่อของคุณ',
  },
  removeConfirm: { en: 'Yes, remove my data', th: 'ยืนยัน ลบข้อมูล' },
  removeRequested: {
    en: 'Done. Your data will be removed within a day.',
    th: 'รับทราบค่ะ ข้อมูลของคุณจะถูกลบภายในหนึ่งวันค่ะ',
  },
  optedOut: {
    en: 'You won’t get promotional messages from us any more. Messages about your own bookings still arrive.',
    th: 'คุณจะไม่ได้รับข้อความโปรโมชันจากเราอีกค่ะ ข้อความเกี่ยวกับการจองของคุณยังส่งถึงตามปกติค่ะ',
  },

  // B4: the data notice (spec §5.5), shown once on first contact. Its version is DATA_NOTICE_VERSION;
  // change the text, change the version.
  dataNotice: {
    en: 'Chats and bookings with {club} are stored and used to run the service, improve answers, and for analytics and marketing by {club} and by us. More: {url}',
    th: 'แชทและการจองกับ {club} จะถูกจัดเก็บและใช้เพื่อให้บริการ ปรับปรุงคำตอบ และเพื่อการวิเคราะห์และการตลาดโดย {club} และโดยเรา ดูเพิ่มเติม: {url}',
  },

  // B22: waitlist and bottle pre-orders.
  joinWaitlist: { en: 'Join waitlist', th: 'ลงชื่อรอคิว' },
  nightSoldOut: {
    en: '{night} is fully booked. Tell us your party size and you can join the waitlist.',
    th: 'คืน {night} เต็มแล้วค่ะ บอกจำนวนท่านเพื่อลงชื่อรอคิวได้ค่ะ',
  },
  waitlistJoined: {
    en: 'You’re on the waitlist for {night} ({pax} guests). We’ll message you here if a table frees up.',
    th: 'ลงชื่อรอคิวคืน {night} ({pax} ท่าน) แล้วค่ะ หากมีโต๊ะว่างจะแจ้งในแชทนี้ค่ะ',
  },
  waitlistAlready: {
    en: 'You’re already on the waitlist for {night} ({pax} guests).',
    th: 'คุณลงชื่อรอคิวคืน {night} ({pax} ท่าน) ไว้แล้วค่ะ',
  },
  waitlistUnavailable: {
    en: 'Sorry, we can’t take a waitlist for {night}.',
    th: 'ขออภัย ไม่สามารถลงชื่อรอคิวคืน {night} ได้ค่ะ',
  },
  waitlistOffer: {
    en: 'Good news: a table for {night} ({pax} guests) just opened up. The first guest to book gets it; this offer is yours for {minutes} minutes.',
    th: 'ข่าวดีค่ะ มีโต๊ะว่างคืน {night} ({pax} ท่าน) แล้ว ใครจองก่อนได้ก่อน ข้อเสนอนี้สำหรับคุณภายใน {minutes} นาทีค่ะ',
  },
  waitlistBook: { en: 'Book now', th: 'จองเลย' },
  waitlistLeave: { en: 'Leave waitlist', th: 'ยกเลิกรอคิว' },
  waitlistLeft: { en: 'You’re off the waitlist.', th: 'ยกเลิกการรอคิวแล้วค่ะ' },
  preorderPrompt: {
    en: 'Want bottles waiting at your table? Pre-order them now; you pay at the club.',
    th: 'ต้องการให้เตรียมขวดไว้ที่โต๊ะไหมคะ? สั่งล่วงหน้าได้เลย ชำระที่ร้านค่ะ',
  },
  preorderBottles: { en: 'Pre-order bottles', th: 'สั่งขวดล่วงหน้า' },
  preorderAdd: { en: 'Add 1', th: 'เพิ่ม 1' },
  preorderSummary: {
    en: 'Your pre-order for {code}, {night}:\n{lines}\nTotal {total} (paid at the club)',
    th: 'รายการสั่งล่วงหน้า โต๊ะ {code} คืน {night}:\n{lines}\nรวม {total} (ชำระที่ร้าน)',
  },
  preorderEmpty: { en: 'Your pre-order is empty.', th: 'ยังไม่มีรายการสั่งล่วงหน้าค่ะ' },
  preorderAddMore: { en: 'Add more', th: 'เพิ่มอีก' },
  preorderClear: { en: 'Clear', th: 'ล้างรายการ' },
  preorderDone: { en: 'Done', th: 'เสร็จแล้ว' },
  preorderSent: { en: 'Thanks, the bar has your pre-order.', th: 'ขอบคุณค่ะ ส่งรายการให้บาร์แล้วค่ะ' },
  preorderClosed: {
    en: 'This booking can’t take a pre-order any more. A host can help.',
    th: 'การจองนี้ไม่สามารถสั่งล่วงหน้าได้แล้วค่ะ พนักงานยินดีช่วยค่ะ',
  },
  preorderLimit: {
    en: 'That’s the most we can take as a pre-order. A host can help with more.',
    th: 'ถึงจำนวนสูงสุดของการสั่งล่วงหน้าแล้วค่ะ หากต้องการเพิ่ม พนักงานยินดีช่วยค่ะ',
  },
} satisfies Record<string, Record<Lang, string>>;

/** B4: version id of the `dataNotice` text, written to `notices.text_version` (spec §5.5). */
export const DATA_NOTICE_VERSION = 'data-v1';

export type StringKey = keyof typeof strings;

export function t(lang: Lang, key: StringKey, vars: Vars = {}): string {
  let s: string = strings[key][lang];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
