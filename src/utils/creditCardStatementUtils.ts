import { creditCardStatementApi } from '@/db/api';
import type { Transaction, Account } from '@/types/types';

/**
 * Automatically creates a credit card statement line item when a transaction is added
 * to a credit card account.
 * 
 * This function:
 * 1. Checks if the account is a credit card
 * 2. Determines the statement month based on transaction date
 * 3. Creates a statement line item linked to the transaction
 * 4. Marks it as pending (unpaid)
 * 
 * @param transaction - The transaction being added
 * @param account - The account the transaction belongs to
 * @param userId - The user ID
 * @returns The created statement line, or null if not a credit card transaction
 */
import { supabase } from '@/db/supabase';

/**
 * Automatically creates a credit card statement line item when a transaction is added
 * to a credit card account.
 * 
 * This function:
 * 1. Checks if the account is a credit card
 * 2. Determines the statement month based on transaction date
 * 3. Creates a statement line item linked to the transaction
 * 4. Marks it as pending (unpaid)
 * 
 * @param transaction - The transaction being added
 * @param account - The account the transaction belongs to
 * @param userId - The user ID
 * @returns The created statement line, or null if not a credit card transaction
 */
export async function createStatementLineForTransaction(
  transaction: Transaction,
  account: Account,
  userId: string
): Promise<any | null> {
  try {
    // Only create statement lines for credit card accounts
    if (account.account_type !== 'credit_card') {
      return null;
    }

    // Only create for purchases/charges, not repayments
    if (transaction.transaction_type === 'credit_card_repayment') {
      return null;
    }

    // Only create for credit card purchases (which are recorded as 'expense' for credit card accounts)
    // AND check that we don't double count if we have a specific 'credit_card_purchase' type
    // Note: In our system, valid types are defined in TransactionType.
    // 'credit_card_purchase' is NOT in TransactionType union, so we check for 'expense' + account type
    // Only create for credit card purchases (which are recorded as 'expense' for credit card accounts)
    if (transaction.transaction_type !== 'expense') {
      return null;
    }

    // Determine statement month (YYYY-MM format)
    const statementMonth = account.statement_day
      ? getStatementMonth(transaction.transaction_date, account.statement_day)
      : transaction.transaction_date.slice(0, 7);

    // Create statement line item
    const statementLine = await creditCardStatementApi.createStatementLine({
      credit_card_id: account.id,
      user_id: userId,
      transaction_id: transaction.id,
      emi_id: null,
      description: transaction.description || 'Credit Card Purchase',
      amount: transaction.amount,
      transaction_date: transaction.transaction_date,
      statement_month: statementMonth,
      status: 'pending',
      paid_amount: 0,
      currency: transaction.currency || 'INR'
    });

    return statementLine;
  } catch (error) {
    // Log error but don't throw - statement line creation is secondary to transaction creation
    console.error('Error creating statement line for transaction:', error);
    return null;
  }
}

/**
 * Creates statement lines for EMI installments.
 * 
 * When an EMI is active, this function can be called to create statement line items
 * for upcoming installments.
 * 
 * @param creditCardId - The credit card account ID
 * @param emiId - The EMI transaction ID
 * @param emiAmount - The EMI installment amount
 * @param nextDueDate - The next due date for the EMI
 * @param description - Description (e.g., "EMI - iPhone")
 * @param userId - The user ID
 * @param currency - Currency code
 * @param statementDay - Optional credit card statement day
 */
export async function createStatementLineForEMI(
  creditCardId: string,
  emiId: string,
  emiAmount: number,
  nextDueDate: string,
  description: string,
  userId: string,
  currency: string = 'INR',
  statementDay?: number
): Promise<any | null> {
  try {
    const statementMonth = statementDay
      ? getStatementMonth(nextDueDate, statementDay)
      : nextDueDate.slice(0, 7);

    const statementLine = await creditCardStatementApi.createStatementLine({
      credit_card_id: creditCardId,
      user_id: userId,
      transaction_id: null,
      emi_id: emiId,
      description: `EMI - ${description}`,
      amount: emiAmount,
      transaction_date: nextDueDate,
      statement_month: statementMonth,
      status: 'pending',
      paid_amount: 0,
      currency
    });

    return statementLine;
  } catch (error) {
    console.error('Error creating statement line for EMI:', error);
    return null;
  }
}

/**
 * Calculates which statement month a transaction falls into.
 * 
 * If transaction date's day of month is after statementStartDate, it falls into the NEXT month's statement.
 * If transaction date's day of month is <= statementStartDate, it falls into THIS month's statement.
 * 
 * @param transactionDate - The transaction date (YYYY-MM-DD)
 * @param statementStartDate - Optional custom statement start date (day of month)
 * @returns Statement month in YYYY-MM format
 */
export function getStatementMonth(
  transactionDate: string,
  statementStartDate: number = 1
): string {
  const [yearStr, monthStr, dayStr] = transactionDate.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10) - 1; // 0-indexed month
  const dayOfMonth = parseInt(dayStr, 10);

  // If transaction date is after the statement date of the month, it belongs to the next month's statement
  if (dayOfMonth > statementStartDate) {
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  // Format as YYYY-MM
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Handles carryover of unpaid statement items to next month's statement.
 * 
 * This should be called when a new statement month begins.
 * Unpaid items from the previous month are duplicated with the new month.
 * 
 * @param creditCardId - The credit card account ID
 * @param currentMonth - Current month in YYYY-MM format
 * @param previousMonth - Previous month in YYYY-MM format
 * @param userId - The user ID
 */
export async function carryoverUnpaidItems(
  creditCardId: string,
  currentMonth: string,
  previousMonth: string,
  userId: string
): Promise<void> {
  try {
    // Get unpaid items from previous month
    // Note: This would need to be fetched from the database first
    // This is a placeholder showing the logic

    const { data: unpaidItems, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('credit_card_id', creditCardId)
      .eq('statement_month', previousMonth)
      .eq('status', 'pending');

    if (error) throw error;

    if (unpaidItems && unpaidItems.length > 0) {
      // Create new items for current month
      const newItems = unpaidItems.map((item: any) => ({
        credit_card_id: creditCardId,
        user_id: userId,
        transaction_id: item.transaction_id,
        emi_id: item.emi_id,
        description: item.description,
        amount: item.amount,
        transaction_date: item.transaction_date,
        statement_month: currentMonth,
        status: 'pending',
        paid_amount: 0,
        currency: item.currency
      }));

      await supabase
        .from('credit_card_statement_lines')
        .insert(newItems);
    }
  } catch (error) {
    console.error('Error carrying over unpaid items:', error);
  }
}
