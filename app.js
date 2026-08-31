/**
 * Passenger entry point (cPanel "Setup Node.js App").
 *
 * cPanel starts the app by loading a single startup file rather than running
 * scripts/start.sh, so there is no shell step here: `prisma db push` is run once
 * by hand from Terminal at deploy time, not on every worker spawn.
 *
 * Passenger patches http.Server#listen, so the port src/web/server.js binds is
 * ignored in favour of the socket Passenger provides. Nothing else changes.
 *
 * Passenger may run several workers. src/services/leader.js ensures only one of
 * them runs the Telegram bot and the payment poller.
 */
import './src/index.js';
