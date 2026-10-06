import {env} from '../_shared/http.js';
import {bookingDatabase} from './database.js';
import {createBookingHandler} from './handler.js';
Deno.serve(createBookingHandler(bookingDatabase(env('VOICE_BOOKING_DATABASE_URL')),
 {secret:env('SONI_BOOKING_SECRET'),enabled:env('VOICE_BOOKING_ENABLED')==='true'}));
