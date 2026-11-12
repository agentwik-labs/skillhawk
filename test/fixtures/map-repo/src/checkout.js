// Checkout flow that builds a cart and calls payments.
import { chargeCard } from './payments.js';
export class Cart {}
export function checkout(cart) { return chargeCard(cart, 1); }
