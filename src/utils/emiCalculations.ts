/**
 * EMI (Equated Monthly Installment) calculation utilities for SmartFinHub
 */

import type { EMITransaction } from '@/types/types';

/**
 * Calculate monthly EMI amount
 * Formula: (Purchase Amount + Bank Charges) / Number of Months
 */
export function calculateMonthlyEMI(
  purchaseAmount: number,
  bankCharges: number,
  months: number
): number {
  if (months <= 0) return 0;
  const totalAmount = purchaseAmount + bankCharges;
  return totalAmount / months;
}

/**
 * Calculate total amount to be paid (including bank charges)
 */
export function calculateTotalEMIAmount(
  purchaseAmount: number,
  bankCharges: number
): number {
  return purchaseAmount + bankCharges;
}

/**
 * Calculate total statement amount or due amount for a credit card
 * This shows the amount that SHOULD be paid, considering EMIs.
 * If the current balance includes the full EMI purchase amount, we only want to show one installment.
 * Formula: Due Amount = Current Balance - Sum of (monthly_emi * (remaining_installments - 1))
 */
export function calculateStatementAmount(
  currentBalance: number,
  activeEMIs: EMITransaction[]
): number {
  const futureEMIPrincipal = activeEMIs.reduce((sum, emi) => {
    // If there are N installments remaining, and 1 is due now, then N-1 are future.
    const installmentsAfterThisOne = Math.max(0, emi.remaining_installments - 1);
    return sum + (emi.monthly_emi * installmentsAfterThisOne);
  }, 0);

  return Math.max(0, currentBalance - futureEMIPrincipal);
}

/**
 * Calculate available credit
 * Available Credit = Credit Limit - Current Balance
 */
export function calculateAvailableCredit(
  currentBalance: number,
  creditLimit: number | null
): number {
  if (!creditLimit) return 0;
  return Math.max(0, creditLimit - currentBalance);
}

/**
 * Calculate credit utilization percentage
 * Credit Utilization = (Current Balance / Credit Limit) * 100
 */
export function calculateCreditUtilization(
  currentBalance: number,
  creditLimit: number | null
): number {
  if (!creditLimit || creditLimit === 0) return 0;
  return (currentBalance / creditLimit) * 100;
}

/**
 * Check if credit limit is being approached or exceeded
 * Returns warning level: 'safe', 'warning' (>80%), 'danger' (>100%)
 */
export function getCreditLimitWarningLevel(
  currentBalance: number,
  creditLimit: number | null
): 'safe' | 'warning' | 'danger' {
  if (!creditLimit) return 'safe';

  const utilization = calculateCreditUtilization(currentBalance, creditLimit);

  if (utilization >= 100) return 'danger';
  if (utilization >= 80) return 'warning';
  return 'safe';
}

/**
 * Get warning message based on credit utilization
 */
export function getCreditLimitWarningMessage(
  currentBalance: number,
  creditLimit: number | null,
  currency: string
): string | null {
  const level = getCreditLimitWarningLevel(currentBalance, creditLimit);
  const utilization = calculateCreditUtilization(currentBalance, creditLimit);

  if (level === 'danger') {
    return `⚠️ Credit limit exceeded! You are at ${utilization.toFixed(1)}% utilization.`;
  }

  if (level === 'warning') {
    const available = calculateAvailableCredit(currentBalance, creditLimit);
    return `⚠️ Approaching credit limit! ${utilization.toFixed(1)}% used. ${currency} ${available.toFixed(2)} available.`;
  }

  return null;
}

export function calculateNextDueDate(startDate: string, monthsToAdd: number = 1): string {
  const date = new Date(startDate);
  date.setMonth(date.getMonth() + monthsToAdd);
  return date.toISOString().split('T')[0];
}

/**
 * Calculates the first installment due date for a credit card EMI.
 * 
 * Typically, if a transaction is done on transactionDate, and the card's statement day is statementDay:
 * - We find the statement date for the month of the transaction.
 * - If the transaction date is within 3 days before the statement date, or after the statement date,
 *   the first installment starts in the next statement cycle (next month).
 * - Otherwise, it starts in the current month's statement cycle.
 */
export function calculateFirstEMIDueDate(
  transactionDateStr: string,
  statementDay: number | null | undefined
): string {
  if (!statementDay) {
    // If no statement day is available, default to 1 month after transaction date
    const [year, monthVal, dayVal] = transactionDateStr.split('-').map(Number);
    const date = new Date(year, monthVal, dayVal);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const [year, monthVal, dayVal] = transactionDateStr.split('-').map(Number);
  const txDate = new Date(year, monthVal - 1, dayVal);
  
  // Find safe statement date in the transaction's month
  const getSafeDate = (y: number, m: number, d: number) => {
    const lastDay = new Date(y, m + 1, 0).getDate();
    const safeDay = Math.min(d, lastDay);
    return new Date(y, m, safeDay);
  };

  let stmtDate = getSafeDate(year, monthVal - 1, statementDay);

  // Difference in days: (stmtDate - txDate) in ms
  const diffDays = (stmtDate.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24);

  // If transaction is too close to statement day (less than 3 days) or after statement day,
  // the first EMI starts in the next billing cycle.
  if (diffDays < 3) {
    // Move to next month
    let nextMonth = monthVal; // (monthVal - 1) + 1
    let nextYear = year;
    if (nextMonth > 11) {
      nextMonth = 0;
      nextYear++;
    }
    stmtDate = getSafeDate(nextYear, nextMonth, statementDay);
  }

  const y = stmtDate.getFullYear();
  const m = String(stmtDate.getMonth() + 1).padStart(2, '0');
  const d = String(stmtDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


/**
 * Calculate remaining amount to be paid for an EMI
 */
export function calculateRemainingEMIAmount(emi: EMITransaction): number {
  return emi.monthly_emi * emi.remaining_installments;
}

/**
 * Calculate total EMI amount for all active EMIs
 */
export function calculateTotalActiveEMIAmount(emis: EMITransaction[]): number {
  return emis
    .filter(emi => emi.status === 'active')
    .reduce((sum, emi) => sum + calculateRemainingEMIAmount(emi), 0);
}

/**
 * Format credit utilization as a percentage string
 */
export function formatCreditUtilization(utilization: number): string {
  return `${utilization.toFixed(1)}%`;
}

/**
 * Get color class for credit utilization display
 */
export function getCreditUtilizationColor(utilization: number): string {
  if (utilization >= 100) return 'text-red-600 dark:text-red-400';
  if (utilization >= 80) return 'text-amber-600 dark:text-amber-400';
  if (utilization >= 50) return 'text-blue-600 dark:text-blue-400';
  return 'text-green-600 dark:text-green-400';
}

/**
 * Validate if a transaction amount is within credit limit
 */
export function validateCreditLimit(
  currentBalance: number,
  transactionAmount: number,
  creditLimit: number | null
): { valid: boolean; message?: string } {
  if (!creditLimit) {
    return { valid: true };
  }

  const newBalance = currentBalance + transactionAmount;

  if (newBalance > creditLimit) {
    const excess = newBalance - creditLimit;
    return {
      valid: false,
      message: `Transaction exceeds credit limit by ${excess.toFixed(2)}. Current balance: ${currentBalance.toFixed(2)}, Credit limit: ${creditLimit.toFixed(2)}`
    };
  }

  return { valid: true };
}

/**
 * Calculate EMI details for display
 */
export interface EMICalculationResult {
  monthlyEMI: number;
  totalAmount: number;
  totalInterest: number;
  effectiveRate: number;
}

export function calculateEMIDetails(
  purchaseAmount: number,
  bankCharges: number,
  months: number
): EMICalculationResult {
  const totalAmount = calculateTotalEMIAmount(purchaseAmount, bankCharges);
  const monthlyEMI = calculateMonthlyEMI(purchaseAmount, bankCharges, months);
  const totalInterest = bankCharges;
  const effectiveRate = months > 0 ? (bankCharges / purchaseAmount) * 100 : 0;

  return {
    monthlyEMI,
    totalAmount,
    totalInterest,
    effectiveRate
  };
}
