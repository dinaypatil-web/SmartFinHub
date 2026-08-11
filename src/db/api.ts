import { supabase } from './supabase';
import type {
  Profile,
  Account,
  Transaction,
  InterestRateHistory,
  Budget,
  EMITransaction,
  LoanEMIPayment,
  AccountWithInterestHistory,
  FinancialSummary,
  BudgetAnalysis,
  IncomeCategoryKey,
  ExpenseCategory,
  BankLink,
  UserCustomBankLink
} from '@/types/types';

export const profileApi = {
  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async updateProfile(userId: string, updates: Partial<Profile>): Promise<Profile> {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Profile not found');
    return data;
  },

  async getProfileByPhone(phoneNumber: string): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone', phoneNumber)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getAllProfiles(): Promise<Profile[]> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }
};

export const accountApi = {
  async getAccounts(userId: string): Promise<Account[]> {
    // Auto-generate EMI statement lines in the background
    creditCardStatementApi.generateEMIStatementLines(userId).catch(err =>
      console.error('Background EMI statement generation error:', err)
    );

    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getAccountById(accountId: string): Promise<Account | null> {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getAccountWithInterestHistory(accountId: string): Promise<AccountWithInterestHistory | null> {
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .maybeSingle();

    if (accountError) throw accountError;
    if (!account) return null;

    const { data: history, error: historyError } = await supabase
      .from('interest_rate_history')
      .select('*')
      .eq('account_id', accountId)
      .order('effective_date', { ascending: false });

    if (historyError) throw historyError;

    return {
      ...account,
      interest_history: Array.isArray(history) ? history : []
    };
  },

  async createAccount(account: Omit<Account, 'id' | 'created_at' | 'updated_at'>): Promise<Account> {
    const accountData = {
      ...account,
      balance: account.balance || 0,
      currency: account.currency || 'INR'
    };

    const { data, error } = await supabase
      .from('accounts')
      .insert(accountData)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create account');

    return data;
  },

  async updateAccount(accountId: string, updates: Partial<Account>): Promise<Account> {
    const updateData = {
      ...updates,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('accounts')
      .update(updateData)
      .eq('id', accountId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Account not found');

    return data;
  },

  async deleteAccount(accountId: string): Promise<void> {
    const { error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', accountId);

    if (error) throw error;
  },

  async getFinancialSummary(userId: string): Promise<FinancialSummary> {
    const accounts = await this.getAccounts(userId);

    const cashAccounts = accounts.filter(a => a.account_type === 'cash');
    const bankAccounts = accounts.filter(a => a.account_type === 'bank');
    const creditCards = accounts.filter(a => a.account_type === 'credit_card');
    const loanAccounts = accounts.filter(a => a.account_type === 'loan');

    const cash_total = cashAccounts.reduce((sum, acc) => sum + Number(acc.balance), 0);
    const bank_total = bankAccounts.reduce((sum, acc) => sum + Number(acc.balance), 0);
    const total_assets = cash_total + bank_total;

    // Credit card balances are negative (debt), so we need to negate them to get positive liability amount
    const total_liabilities = Math.abs(creditCards.reduce((sum, acc) => sum + Number(acc.balance), 0));

    const liquid_assets = total_assets;
    const working_capital = total_assets - total_liabilities;

    return {
      total_assets,
      total_liabilities,
      liquid_assets,
      working_capital,
      accounts_by_type: {
        cash: cashAccounts,
        bank: bankAccounts,
        credit_card: creditCards,
        loan: loanAccounts
      }
    };
  },

  async getLoanWithCalculations(accountId: string): Promise<any> {
    const { data, error } = await supabase
      .rpc('get_loan_details_with_calculations', { p_account_id: accountId });

    if (error) throw error;
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  },

  async calculateLoanEMI(principal: number, annualRate: number, tenureMonths: number): Promise<number> {
    const { data, error } = await supabase
      .rpc('calculate_loan_emi', {
        p_principal: principal,
        p_annual_rate: annualRate,
        p_tenure_months: tenureMonths
      });

    if (error) throw error;
    return data || 0;
  },

  async calculateLoanAccruedInterest(accountId: string): Promise<number> {
    const { data, error } = await supabase
      .rpc('calculate_loan_accrued_interest', { p_account_id: accountId });

    if (error) throw error;
    return data || 0;
  },

  async adjustBalance(accountId: string, adjustment: number): Promise<void> {
    const account = await this.getAccountById(accountId);
    if (!account) return;

    const newBalance = Number(account.balance) + adjustment;
    await this.updateAccount(accountId, { balance: newBalance });
  }
};

export const interestRateApi = {
  async getInterestRates(userId?: string): Promise<InterestRateHistory[]> {
    let query = supabase
      .from('interest_rate_history')
      .select('*, accounts!inner(user_id)')
      .order('effective_date', { ascending: false });

    if (userId) {
      query = query.eq('accounts.user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getInterestRateHistory(accountId: string): Promise<InterestRateHistory[]> {
    const { data, error } = await supabase
      .from('interest_rate_history')
      .select('*')
      .eq('account_id', accountId)
      .order('effective_date', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async addInterestRate(rate: Omit<InterestRateHistory, 'id' | 'created_at'>): Promise<InterestRateHistory> {
    const { data, error } = await supabase
      .from('interest_rate_history')
      .insert(rate)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to add interest rate');
    return data;
  },

  async createInterestRate(rate: Omit<InterestRateHistory, 'id' | 'created_at'>): Promise<InterestRateHistory> {
    return interestRateApi.addInterestRate(rate);
  },

  async deleteInterestRate(rateId: string): Promise<void> {
    const { error } = await supabase
      .from('interest_rate_history')
      .delete()
      .eq('id', rateId);

    if (error) throw error;
  }
};

export const transactionApi = {
  async getTransactions(userId: string, limit?: number): Promise<Transaction[]> {
    let query = supabase
      .from('transactions')
      .select('*, transaction_splits(*)')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getTransactionsByDateRange(userId: string, startDate: string, endDate: string): Promise<Transaction[]> {
    const { data, error } = await supabase
      .from('transactions')
      .select('*, transaction_splits(*)')
      .eq('user_id', userId)
      .gte('transaction_date', startDate)
      .lte('transaction_date', endDate)
      .order('transaction_date', { ascending: false });

    if (error) throw error;
    const transactions = Array.isArray(data) ? data : [];

    return transactions;
  },

  async getTransactionsByCategory(userId: string, category: string): Promise<Transaction[]> {
    const { data, error } = await supabase
      .from('transactions')
      .select('*, transaction_splits(*)')
      .eq('user_id', userId)
      .eq('category', category)
      .order('transaction_date', { ascending: false });

    if (error) throw error;
    const transactions = Array.isArray(data) ? data : [];

    return transactions;
  },

  async getTransactionsByAccount(userId: string, accountId: string): Promise<Transaction[]> {
    const { data, error } = await supabase
      .from('transactions')
      .select('*, transaction_splits(*)')
      .eq('user_id', userId)
      .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
      .order('transaction_date', { ascending: false });

    if (error) throw error;
    const transactions = Array.isArray(data) ? data : [];

    return transactions;
  },

  async createTransaction(transaction: Omit<Transaction, 'id' | 'created_at' | 'updated_at'> & { transaction_splits?: any[] }): Promise<Transaction> {
    // Extract loan_components and transaction_splits to prevent sending it to the database
    const { loan_components, transaction_splits, ...restTransaction } = transaction as any;

    const transactionData = {
      ...restTransaction,
      currency: restTransaction.currency || 'INR'
    };

    const { data, error } = await supabase
      .from('transactions')
      .insert(transactionData)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create transaction');

    // Insert splits if present
    if (transaction_splits && transaction_splits.length > 0) {
      const splitsToInsert = transaction_splits.map(s => ({
        transaction_id: data.id,
        user_id: data.user_id,
        category: s.category,
        amount: Number(s.amount),
        description: s.description || null
      }));

      const { error: splitsError } = await supabase
        .from('transaction_splits')
        .insert(splitsToInsert);

      if (splitsError) throw splitsError;
      data.transaction_splits = splitsToInsert;
    }

    await this.updateAccountBalances(transaction, (transaction as any).loan_components);

    // Phase 1: Support Credit Card Statement Lines (Added in previous task)
    // Skip if it's an EMI purchase or has "EMI" in the description
    const isEmiTagged = transaction.description?.toLowerCase().includes('emi');
    if (transaction.transaction_type === 'expense' && transaction.from_account_id && !isEmiTagged) {
      const fromAccount = await accountApi.getAccountById(transaction.from_account_id);
      if (fromAccount?.account_type === 'credit_card') {
        const statementMonth = transaction.transaction_date.slice(0, 7);
        await creditCardStatementApi.createStatementLine({
          credit_card_id: transaction.from_account_id,
          user_id: transaction.user_id,
          transaction_id: data.id,
          description: transaction.description || 'Credit Card Transaction',
          amount: transaction.amount,
          transaction_date: transaction.transaction_date,
          statement_month: statementMonth,
          status: 'pending'
        });
      }
    }

    // Phase 2: Support Loan EMI Payments (Automatic Bifurcation)
    if (transaction.transaction_type === 'loan_payment' && transaction.to_account_id) {
      const loanAccount = await accountApi.getAccountById(transaction.to_account_id);
      if (loanAccount && loanAccount.account_type === 'loan') {
        const amount = Number(transaction.amount);
        const interestRate = Number(loanAccount.current_interest_rate || 0);
        const currentBalance = Number(loanAccount.balance);

        // Calculate components
        const monthlyRate = (interestRate / 100) / 12;
        const loan_components = (transaction as any).loan_components;
        const interestComponent = loan_components ? Number(loan_components.interest) : Number((currentBalance * monthlyRate).toFixed(2));
        const principalComponent = loan_components ? Number(loan_components.principal) : Number((amount - interestComponent).toFixed(2));
        const outstandingPrincipal = Number((currentBalance - principalComponent).toFixed(2));

        // DEDUPLICATION: Check if an EMI payment already exists for this date and account
        const existingPayments = await loanEMIPaymentApi.getPaymentsByAccount(transaction.to_account_id);
        const existingPayment = existingPayments.find(p => p.payment_date === transaction.transaction_date);

        if (existingPayment) {
          // Update existing instead of creating new
          await loanEMIPaymentApi.updatePayment(existingPayment.id, {
            transaction_id: data.id,
            emi_amount: amount,
            principal_component: principalComponent,
            interest_component: interestComponent,
            outstanding_principal: outstandingPrincipal,
            notes: transaction.description || existingPayment.notes
          });
        } else {
          const nextPaymentNumber = await loanEMIPaymentApi.getNextPaymentNumber(transaction.to_account_id);
          await loanEMIPaymentApi.createPayment({
            user_id: transaction.user_id,
            account_id: transaction.to_account_id,
            payment_date: transaction.transaction_date,
            emi_amount: amount,
            principal_component: principalComponent,
            interest_component: interestComponent,
            outstanding_principal: outstandingPrincipal,
            interest_rate: interestRate,
            payment_number: nextPaymentNumber,
            transaction_id: data.id,
            notes: transaction.description
          });
        }
      }
    }

    return data;
  },

  async updateTransaction(transactionId: string, updates: Partial<Transaction> & { transaction_splits?: any[] }): Promise<Transaction> {
    const { data: oldTransaction } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    const newTransactionType = updates.transaction_type !== undefined ? updates.transaction_type : oldTransaction?.transaction_type;
    const newFromAccountId = updates.from_account_id !== undefined ? updates.from_account_id : oldTransaction?.from_account_id;
    const newToAccountId = updates.to_account_id !== undefined ? updates.to_account_id : oldTransaction?.to_account_id;

    const isDifferentialUpdate = !!oldTransaction &&
      (newTransactionType === oldTransaction.transaction_type &&
       newFromAccountId === oldTransaction.from_account_id &&
       newToAccountId === oldTransaction.to_account_id);

    if (oldTransaction && !isDifferentialUpdate) {
      await this.reverseAccountBalances(oldTransaction);
    }

    // Extract loan_components and transaction_splits to prevent sending it to the database
    const { loan_components, transaction_splits, ...restUpdates } = updates as any;

    const updateData = {
      ...restUpdates,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('transactions')
      .update(updateData)
      .eq('id', transactionId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Transaction not found');

    // Update splits: delete previous splits first
    const { error: deleteSplitsError } = await supabase
      .from('transaction_splits')
      .delete()
      .eq('transaction_id', transactionId);

    if (deleteSplitsError) throw deleteSplitsError;

    // Insert new splits if present
    if (transaction_splits && transaction_splits.length > 0) {
      const splitsToInsert = transaction_splits.map(s => ({
        transaction_id: transactionId,
        user_id: data.user_id,
        category: s.category,
        amount: Number(s.amount),
        description: s.description || null
      }));

      const { error: splitsError } = await supabase
        .from('transaction_splits')
        .insert(splitsToInsert);

      if (splitsError) throw splitsError;
      data.transaction_splits = splitsToInsert;
    }

    if (oldTransaction) {
      if (isDifferentialUpdate) {
        await this.applyDifferentialUpdateBalances(oldTransaction, data, (updates as any).loan_components);
      } else {
        await this.updateAccountBalances(data, (updates as any).loan_components);
      }

      // Update associated records
      if (data.transaction_type === 'loan_payment' && data.to_account_id) {
        // Delete old (wait, this might be too drastic if we want to deduplicate)
        // Instead of deleting all with transaction_id, let's just ensure we have one
        await supabase.from('loan_emi_payments').delete().eq('transaction_id', transactionId);

        const loanAccount = await accountApi.getAccountById(data.to_account_id);
        if (loanAccount && loanAccount.account_type === 'loan') {
          const amount = Number(data.amount);
          const interestRate = Number(loanAccount.current_interest_rate || 0);
          const currentBalance = Number(loanAccount.balance);
          const monthlyRate = (interestRate / 100) / 12;
          const loan_components = (updates as any).loan_components;
          const interestComponent = loan_components ? Number(loan_components.interest) : Number((currentBalance * monthlyRate).toFixed(2));
          const principalComponent = loan_components ? Number(loan_components.principal) : Number((amount - interestComponent).toFixed(2));
          const outstandingPrincipal = Number((currentBalance - principalComponent).toFixed(2));

          // Check for manual entry on same date
          const existingPayments = await loanEMIPaymentApi.getPaymentsByAccount(data.to_account_id);
          const existingPayment = existingPayments.find(p => p.payment_date === data.transaction_date && !p.transaction_id);

          if (existingPayment) {
            await loanEMIPaymentApi.updatePayment(existingPayment.id, {
              transaction_id: data.id,
              emi_amount: amount,
              principal_component: principalComponent,
              interest_component: interestComponent,
              outstanding_principal: outstandingPrincipal,
              notes: data.description || existingPayment.notes
            });
          } else {
            const nextPaymentNumber = await loanEMIPaymentApi.getNextPaymentNumber(data.to_account_id);
            await loanEMIPaymentApi.createPayment({
              user_id: data.user_id,
              account_id: data.to_account_id,
              payment_date: data.transaction_date,
              emi_amount: amount,
              principal_component: principalComponent,
              interest_component: interestComponent,
              outstanding_principal: outstandingPrincipal,
              interest_rate: interestRate,
              payment_number: nextPaymentNumber,
              transaction_id: data.id,
              notes: data.description
            });
          }
        }
      }

      if (data.transaction_type === 'expense' && data.from_account_id) {
        const fromAccount = await accountApi.getAccountById(data.from_account_id);
        if (fromAccount?.account_type === 'credit_card') {
          // Delete old
          await supabase.from('credit_card_statement_lines').delete().eq('transaction_id', transactionId);

          // Create new
          const statementMonth = data.transaction_date.slice(0, 7);
          await creditCardStatementApi.createStatementLine({
            credit_card_id: data.from_account_id,
            user_id: data.user_id,
            transaction_id: data.id,
            description: data.description || 'Credit Card Transaction',
            amount: data.amount,
            transaction_date: data.transaction_date,
            statement_month: statementMonth,
            status: 'pending'
          });
        }
      }
    }

    return data;
  },

  async deleteTransaction(transactionId: string): Promise<void> {
    const { data: transaction } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (transaction) {
      // 1. Reverse account balances first (so that sub-step cleanup queries like CC repayment reverse can lookup the transaction)
      await this.reverseAccountBalances(transaction);

      // 2. Delete associated credit card statement lines
      if (transaction.transaction_type === 'expense' && transaction.from_account_id) {
        await supabase
          .from('credit_card_statement_lines')
          .delete()
          .eq('transaction_id', transactionId);
      }

      // 3. Delete associated loan EMI payments
      if (transaction.transaction_type === 'loan_payment' && transaction.to_account_id) {
        await supabase
          .from('loan_emi_payments')
          .delete()
          .eq('transaction_id', transactionId);
      }
    }

    // 4. Finally delete the transaction record itself from the database
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', transactionId);

    if (error) throw error;
  },

  async applyDifferentialUpdateBalances(
    oldTransaction: Transaction,
    newTransaction: Transaction,
    loanComponents?: { principal: number; interest: number }
  ): Promise<void> {
    const diff = Number(newTransaction.amount) - Number(oldTransaction.amount);

    switch (newTransaction.transaction_type) {
      case 'income':
        if (newTransaction.to_account_id && diff !== 0) {
          await this.adjustBalance(newTransaction.to_account_id, diff);
        }
        break;

      case 'expense':
        if (newTransaction.from_account_id && diff !== 0) {
          const account = await accountApi.getAccountById(newTransaction.from_account_id);
          if (account?.account_type === 'credit_card') {
            await this.adjustBalance(newTransaction.from_account_id, diff);
          } else {
            await this.adjustBalance(newTransaction.from_account_id, -diff);
          }
        }
        break;

      case 'withdrawal':
        if (diff !== 0) {
          if (newTransaction.from_account_id) {
            const account = await accountApi.getAccountById(newTransaction.from_account_id);
            if (account?.account_type === 'credit_card') {
              await this.adjustBalance(newTransaction.from_account_id, diff);
            } else {
              await this.adjustBalance(newTransaction.from_account_id, -diff);
            }
          }
          if (newTransaction.to_account_id) {
            await this.adjustBalance(newTransaction.to_account_id, diff);
          }
        }
        break;

      case 'transfer':
        if (diff !== 0) {
          if (newTransaction.from_account_id) {
            const fromAccount = await accountApi.getAccountById(newTransaction.from_account_id);
            if (fromAccount?.account_type === 'credit_card') {
              await this.adjustBalance(newTransaction.from_account_id, diff);
            } else {
              await this.adjustBalance(newTransaction.from_account_id, -diff);
            }
          }
          if (newTransaction.to_account_id) {
            const toAccount = await accountApi.getAccountById(newTransaction.to_account_id);
            if (toAccount?.account_type === 'credit_card') {
              await this.adjustBalance(newTransaction.to_account_id, -diff);
            } else {
              await this.adjustBalance(newTransaction.to_account_id, diff);
            }
          }
        }
        break;

      case 'loan_payment': {
        if (newTransaction.from_account_id && diff !== 0) {
          await this.adjustBalance(newTransaction.from_account_id, -diff);
        }

        if (newTransaction.to_account_id) {
          const loanAccount = await accountApi.getAccountById(newTransaction.to_account_id);
          if (loanAccount && loanAccount.account_type === 'loan') {
            const interestRate = Number(loanAccount.current_interest_rate || 0);
            const monthlyRate = (interestRate / 100) / 12;

            // Fetch old principal component from loan_emi_payments
            let oldPrincipal = Number(oldTransaction.amount);
            try {
              const { data: emiRecord } = await supabase
                .from('loan_emi_payments')
                .select('principal_component')
                .eq('transaction_id', oldTransaction.id)
                .maybeSingle();

              if (emiRecord) {
                oldPrincipal = Number(emiRecord.principal_component);
              } else {
                const oldInterest = Number((Number(loanAccount.balance) * monthlyRate).toFixed(2));
                oldPrincipal = Number(oldTransaction.amount) - oldInterest;
              }
            } catch (e) {
              console.error('Error fetching old principal component:', e);
              const oldInterest = Number((Number(loanAccount.balance) * monthlyRate).toFixed(2));
              oldPrincipal = Number(oldTransaction.amount) - oldInterest;
            }

            // Calculate new principal component
            let newPrincipal = Number(newTransaction.amount);
            if (loanComponents) {
              newPrincipal = Number(loanComponents.principal);
            } else {
              const newInterest = Number((Number(loanAccount.balance) * monthlyRate).toFixed(2));
              newPrincipal = Number(newTransaction.amount) - newInterest;
            }

            const principalDiff = newPrincipal - oldPrincipal;
            if (principalDiff !== 0) {
              await this.adjustBalance(newTransaction.to_account_id, -principalDiff);
            }
          } else {
            if (diff !== 0) {
              await this.adjustBalance(newTransaction.to_account_id, -diff);
            }
          }
        }
        break;
      }

      case 'credit_card_repayment':
        // Run credit card repayment reversal (statement lines, EMI installments, advance balance)
        // first to fully reset allocations/advances before the new ones are written
        try {
          await creditCardStatementApi.reverseRepayment(oldTransaction.id);
        } catch (e) {
          console.error('Error running reverseRepayment in differential update:', e);
        }

        if (diff !== 0) {
          if (newTransaction.from_account_id) {
            await this.adjustBalance(newTransaction.from_account_id, -diff);
          }
          if (newTransaction.to_account_id) {
            await this.adjustBalance(newTransaction.to_account_id, -diff);
          }
        }
        break;
    }
  },

  async updateAccountBalances(
    transaction: Transaction | Omit<Transaction, 'id' | 'created_at' | 'updated_at'>,
    loanComponents?: { principal: number; interest: number }
  ): Promise<void> {
    const amount = Number(transaction.amount);

    switch (transaction.transaction_type) {
      case 'income':
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, amount);
        }
        break;

      case 'expense':
        if (transaction.from_account_id) {
          const account = await accountApi.getAccountById(transaction.from_account_id);
          if (account?.account_type === 'credit_card') {
            // Credit card: expense increases balance (debt)
            await this.adjustBalance(transaction.from_account_id, amount);
          } else {
            // Bank/Cash account: expense decreases balance
            await this.adjustBalance(transaction.from_account_id, -amount);
          }
        }
        break;

      case 'withdrawal':
        // Deduct from source account (bank/credit card)
        if (transaction.from_account_id) {
          const account = await accountApi.getAccountById(transaction.from_account_id);
          if (account?.account_type === 'credit_card') {
            // Credit card: withdrawal increases balance (debt)
            await this.adjustBalance(transaction.from_account_id, amount);
          } else {
            // Bank account: withdrawal decreases balance
            await this.adjustBalance(transaction.from_account_id, -amount);
          }
        }
        // Add to destination cash account
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, amount);
        }
        break;

      case 'transfer':
        if (transaction.from_account_id) {
          const fromAccount = await accountApi.getAccountById(transaction.from_account_id);
          if (fromAccount?.account_type === 'credit_card') {
            // Credit card: transfer from credit card increases balance (cash advance/debt)
            await this.adjustBalance(transaction.from_account_id, amount);
          } else {
            // Bank/Cash account: transfer decreases balance
            await this.adjustBalance(transaction.from_account_id, -amount);
          }
        }
        if (transaction.to_account_id) {
          const toAccount = await accountApi.getAccountById(transaction.to_account_id);
          if (toAccount?.account_type === 'credit_card') {
            // Credit card: transfer to credit card decreases balance (payment/reduces debt)
            await this.adjustBalance(transaction.to_account_id, -amount);
          } else {
            // Bank/Cash account: transfer increases balance
            await this.adjustBalance(transaction.to_account_id, amount);
          }
        }
        break;

      case 'loan_payment':
        if (transaction.from_account_id) {
          await this.adjustBalance(transaction.from_account_id, -amount);
        }
        if (transaction.to_account_id) {
          const loanAccount = await accountApi.getAccountById(transaction.to_account_id);
          if (loanAccount && loanAccount.account_type === 'loan') {
            const interestRate = Number(loanAccount.current_interest_rate || 0);
            const currentBalance = Number(loanAccount.balance);
            const monthlyRate = (interestRate / 100) / 12;
            const loan_components = loanComponents;
            const interest = loan_components ? Number(loan_components.interest) : Number((currentBalance * monthlyRate).toFixed(2));
            const principal = loan_components ? Number(loan_components.principal) : amount - interest;
            // Subtract only the principal component from the loan balance
            await this.adjustBalance(transaction.to_account_id, -principal);
          } else {
            // Default fallback if account not found or not a loan
            await this.adjustBalance(transaction.to_account_id, -amount);
          }
        }
        break;

      case 'credit_card_repayment':
        // FROM account (bank/cash): decrease balance
        if (transaction.from_account_id) {
          await this.adjustBalance(transaction.from_account_id, -amount);
        }
        // TO account (credit card): decrease balance (reduce liability)
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, -amount);
        }
        break;
    }
  },

  async reverseAccountBalances(transaction: Transaction): Promise<void> {
    const amount = Number(transaction.amount);

    switch (transaction.transaction_type) {
      case 'income':
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, -amount);
        }
        break;

      case 'expense':
        if (transaction.from_account_id) {
          const account = await accountApi.getAccountById(transaction.from_account_id);
          if (account?.account_type === 'credit_card') {
            // Credit card: reverse expense decreases balance (debt)
            await this.adjustBalance(transaction.from_account_id, -amount);
          } else {
            // Bank/Cash account: reverse expense increases balance
            await this.adjustBalance(transaction.from_account_id, amount);
          }
        }
        break;

      case 'withdrawal':
        // Reverse: Add back to source account (bank/credit card)
        if (transaction.from_account_id) {
          const account = await accountApi.getAccountById(transaction.from_account_id);
          if (account?.account_type === 'credit_card') {
            // Credit card: reverse withdrawal decreases balance (debt)
            await this.adjustBalance(transaction.from_account_id, -amount);
          } else {
            // Bank account: reverse withdrawal increases balance
            await this.adjustBalance(transaction.from_account_id, amount);
          }
        }
        // Reverse: Deduct from destination cash account
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, -amount);
        }
        break;

      case 'transfer':
        if (transaction.from_account_id) {
          const fromAccount = await accountApi.getAccountById(transaction.from_account_id);
          if (fromAccount?.account_type === 'credit_card') {
            // Credit card: reverse transfer from credit card decreases balance (reverse cash advance)
            await this.adjustBalance(transaction.from_account_id, -amount);
          } else {
            // Bank/Cash account: reverse transfer increases balance
            await this.adjustBalance(transaction.from_account_id, amount);
          }
        }
        if (transaction.to_account_id) {
          const toAccount = await accountApi.getAccountById(transaction.to_account_id);
          if (toAccount?.account_type === 'credit_card') {
            // Credit card: reverse transfer to credit card increases balance (reverse payment)
            await this.adjustBalance(transaction.to_account_id, amount);
          } else {
            // Bank/Cash account: reverse transfer decreases balance
            await this.adjustBalance(transaction.to_account_id, -amount);
          }
        }
        break;

      case 'loan_payment':
        if (transaction.from_account_id) {
          await this.adjustBalance(transaction.from_account_id, amount);
        }
        if (transaction.to_account_id) {
          const loanAccount = await accountApi.getAccountById(transaction.to_account_id);
          if (loanAccount && loanAccount.account_type === 'loan') {
            const interestRate = Number(loanAccount.current_interest_rate || 0);
            const currentBalance = Number(loanAccount.balance);
            const monthlyRate = (interestRate / 100) / 12;
            const interest = Number((currentBalance * monthlyRate).toFixed(2));
            const principal = amount - interest;
            // Add back only the principal component
            await this.adjustBalance(transaction.to_account_id, principal);
          } else {
            await this.adjustBalance(transaction.to_account_id, amount);
          }
        }
        break;

      case 'credit_card_repayment':
        // Reverse: FROM account (bank/cash): increase balance
        if (transaction.from_account_id) {
          await this.adjustBalance(transaction.from_account_id, amount);
        }
        // Reverse: TO account (credit card): increase balance (restore liability)
        if (transaction.to_account_id) {
          await this.adjustBalance(transaction.to_account_id, amount);

          // REVERSAL: Reverse the effects of the credit card repayment (statement lines, EMI installments, advance balance)
          await creditCardStatementApi.reverseRepayment(transaction.id);
        }
        break;
    }
  },

  async adjustBalance(accountId: string, adjustment: number): Promise<void> {
    await accountApi.adjustBalance(accountId, adjustment);
  }
};

export const budgetApi = {
  async getBudget(userId: string, month: number, year: number): Promise<Budget | null> {
    const { data, error } = await supabase
      .from('budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('month', month)
      .eq('year', year)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getBudgets(userId: string): Promise<Budget[]> {
    const { data, error } = await supabase
      .from('budgets')
      .select('*')
      .eq('user_id', userId)
      .order('year', { ascending: false })
      .order('month', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async createOrUpdateBudget(budget: Omit<Budget, 'id' | 'created_at' | 'updated_at'>): Promise<Budget> {
    const existing = await this.getBudget(budget.user_id, budget.month, budget.year);

    if (existing) {
      const { data, error } = await supabase
        .from('budgets')
        .update({ ...budget, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Failed to update budget');
      return data;
    } else {
      const { data, error } = await supabase
        .from('budgets')
        .insert({
          ...budget,
          currency: budget.currency || 'INR',
          budgeted_income: budget.budgeted_income || 0,
          budgeted_expenses: budget.budgeted_expenses || 0,
          category_budgets: budget.category_budgets || {},
          income_category_budgets: budget.income_category_budgets || {}
        })
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Failed to create budget');
      return data;
    }
  },

  async deleteBudget(budgetId: string): Promise<void> {
    const { error } = await supabase
      .from('budgets')
      .delete()
      .eq('id', budgetId);

    if (error) throw error;
  },

  async getBudgetAnalysis(userId: string, month: number, year: number): Promise<BudgetAnalysis | null> {
    const budget = await this.getBudget(userId, month, year);
    if (!budget) return null;

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const transactions = await transactionApi.getTransactionsByDateRange(userId, startDate, endDate);

    const actual_income = transactions
      .filter(t => t.transaction_type === 'income')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const actual_expenses = transactions
      .filter(t => t.transaction_type === 'expense' || t.transaction_type === 'loan_payment')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Fetch categories to map ID to name
    const categories = await categoryApi.getCategories(userId);
    const categoryMap = new Map(categories.map(c => [c.id, c.name]));

    const category_analysis: Record<string, { budgeted: number; actual: number; variance: number }> = {};

    for (const [categoryId, budgeted] of Object.entries(budget.category_budgets)) {
      const categoryName = categoryMap.get(categoryId);
      if (!categoryName) continue;

      const actual = transactions
        .reduce((sum, t) => {
          if (t.transaction_splits && t.transaction_splits.length > 0) {
            const splitSum = t.transaction_splits
              .filter(s => s.category === categoryName && (t.transaction_type === 'expense' || t.transaction_type === 'loan_payment'))
              .reduce((sSum, s) => sSum + Number(s.amount), 0);
            return sum + splitSum;
          } else {
            const isMatch = t.category === categoryName && (t.transaction_type === 'expense' || t.transaction_type === 'loan_payment');
            return sum + (isMatch ? Number(t.amount) : 0);
          }
        }, 0);

      category_analysis[categoryId] = {
        budgeted: Number(budgeted),
        actual,
        variance: Number(budgeted) - actual
      };
    }

    // Income category analysis
    const income_category_analysis: Record<IncomeCategoryKey, { budgeted: number; actual: number; variance: number }> = {
      salaries: { budgeted: 0, actual: 0, variance: 0 },
      allowances: { budgeted: 0, actual: 0, variance: 0 },
      family_income: { budgeted: 0, actual: 0, variance: 0 },
      others: { budgeted: 0, actual: 0, variance: 0 }
    };

    // Calculate actual income by category from transactions
    const incomeTransactions = transactions.filter(t => t.transaction_type === 'income');
    const actualIncomeByCategory: Record<string, number> = {};

    for (const transaction of incomeTransactions) {
      if (transaction.income_category) {
        actualIncomeByCategory[transaction.income_category] =
          (actualIncomeByCategory[transaction.income_category] || 0) + Number(transaction.amount);
      }
    }

    // Calculate uncategorized income (for proportional distribution)
    const categorizedIncome = Object.values(actualIncomeByCategory).reduce((sum, val) => sum + val, 0);
    const uncategorizedIncome = actual_income - categorizedIncome;

    // Process income category budgets
    if (budget.income_category_budgets) {
      const incomeBudgets = budget.income_category_budgets as Record<IncomeCategoryKey, number>;
      const totalBudgetedIncome = Object.values(incomeBudgets).reduce((sum: number, val) => sum + Number(val), 0);

      for (const [categoryKey, budgeted] of Object.entries(incomeBudgets)) {
        if (categoryKey in income_category_analysis) {
          const key = categoryKey as IncomeCategoryKey;
          const budgetedAmount = Number(budgeted);

          // Use actual categorized income if available
          let actual = actualIncomeByCategory[key] || 0;

          // Distribute uncategorized income proportionally if there's any
          if (uncategorizedIncome > 0 && totalBudgetedIncome > 0) {
            const proportion = budgetedAmount / totalBudgetedIncome;
            actual += uncategorizedIncome * proportion;
          }

          income_category_analysis[key] = {
            budgeted: budgetedAmount,
            actual,
            variance: actual - budgetedAmount
          };
        }
      }
    }

    return {
      budget,
      actual_income,
      actual_expenses,
      income_variance: actual_income - Number(budget.budgeted_income),
      expense_variance: Number(budget.budgeted_expenses) - actual_expenses,
      category_analysis,
      income_category_analysis
    };
  },

  async getCategoryBudgetInfo(userId: string, categoryName: string, month: number, year: number): Promise<{ budgeted: number; spent: number; remaining: number } | null> {
    const budget = await this.getBudget(userId, month, year);
    if (!budget) return null;

    // Find category ID by name
    const categories = await categoryApi.getCategories(userId);
    const category = categories.find(c => c.name === categoryName);
    if (!category) return null;

    const budgeted = Number(budget.category_budgets[category.id] || 0);
    if (budgeted === 0) return null;

    // Calculate spent amount for this category in the current month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const transactions = await transactionApi.getTransactionsByDateRange(userId, startDate, endDate);
    const spent = transactions
      .reduce((sum, t) => {
        if (t.transaction_splits && t.transaction_splits.length > 0) {
          const splitSum = t.transaction_splits
            .filter(s => s.category === categoryName && (t.transaction_type === 'expense' || t.transaction_type === 'loan_payment'))
            .reduce((sSum, s) => sSum + Number(s.amount), 0);
          return sum + splitSum;
        } else {
          const isMatch = t.category === categoryName && (t.transaction_type === 'expense' || t.transaction_type === 'loan_payment');
          return sum + (isMatch ? Number(t.amount) : 0);
        }
      }, 0);

    return {
      budgeted,
      spent,
      remaining: budgeted - spent
    };
  }
};

export const categoryApi = {
  async getCategories(userId?: string): Promise<ExpenseCategory[]> {
    let query = supabase
      .from('expense_categories')
      .select('*')
      .order('is_system', { ascending: false })
      .order('name', { ascending: true });

    if (userId) {
      query = query.or(`is_system.eq.true,user_id.eq.${userId}`);
    } else {
      query = query.eq('is_system', true);
    }

    const { data, error } = await query;

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async createCategory(category: Omit<ExpenseCategory, 'id' | 'created_at'>): Promise<ExpenseCategory> {
    const { data, error } = await supabase
      .from('expense_categories')
      .insert({
        ...category,
        icon: category.icon || '📁',
        color: category.color || '#6B7280',
        is_system: false
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create category');
    return data;
  },

  async deleteCategory(categoryId: string): Promise<void> {
    const { error } = await supabase
      .from('expense_categories')
      .delete()
      .eq('id', categoryId);

    if (error) throw error;
  }
};

export const emiApi = {
  async getEMIsByAccount(accountId: string): Promise<EMITransaction[]> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getEMIById(id: string): Promise<EMITransaction | null> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getEMIByTransactionId(transactionId: string): Promise<EMITransaction | null> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getActiveEMIsByAccount(accountId: string): Promise<EMITransaction[]> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .order('next_due_date', { ascending: true });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getEMIsByUser(userId: string): Promise<EMITransaction[]> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async createEMI(emi: Omit<EMITransaction, 'id' | 'created_at' | 'updated_at'>): Promise<EMITransaction> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .insert(emi)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create EMI transaction');

    // If this EMI is linked to a transaction, remove any existing statement line for that transaction
    // to prevent double counting (purchase vs installments)
    if (emi.transaction_id) {
      await supabase
        .from('credit_card_statement_lines')
        .delete()
        .eq('transaction_id', emi.transaction_id);
    }

    return data;
  },

  async updateEMI(id: string, updates: Partial<EMITransaction>): Promise<EMITransaction> {
    const { data, error } = await supabase
      .from('emi_transactions')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to update EMI transaction');
    return data;
  },

  async deleteEMI(id: string): Promise<void> {
    const { error } = await supabase
      .from('emi_transactions')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async payEMIInstallment(emiId: string): Promise<EMITransaction> {
    const { data: emi, error: fetchError } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('id', emiId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!emi) throw new Error('EMI transaction not found');

    const remainingInstallments = emi.remaining_installments - 1;
    const status = remainingInstallments === 0 ? 'completed' : 'active';
    const nextDueDate = remainingInstallments > 0
      ? new Date(new Date(emi.next_due_date).setMonth(new Date(emi.next_due_date).getMonth() + 1)).toISOString().split('T')[0]
      : emi.next_due_date;

    const { data, error } = await supabase
      .from('emi_transactions')
      .update({
        remaining_installments: remainingInstallments,
        next_due_date: nextDueDate,
        status
      })
      .eq('id', emiId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to update EMI installment');
    return data;
  },

  async unpayEMIInstallment(emiId: string): Promise<EMITransaction> {
    const { data: emi, error: fetchError } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('id', emiId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!emi) throw new Error('EMI transaction not found');

    const remainingInstallments = emi.remaining_installments + 1;
    const status = 'active';
    const nextDueDate = new Date(new Date(emi.next_due_date).setMonth(new Date(emi.next_due_date).getMonth() - 1)).toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('emi_transactions')
      .update({
        remaining_installments: remainingInstallments,
        next_due_date: nextDueDate,
        status
      })
      .eq('id', emiId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to revert EMI installment');
    return data;
  },

  async cancelEMI(emiId: string): Promise<EMITransaction> {
    return this.updateEMI(emiId, { status: 'cancelled' });
  }
};

export const loanEMIPaymentApi = {
  async getLoanEMIPayments(userId?: string): Promise<LoanEMIPayment[]> {
    let query = supabase
      .from('loan_emi_payments')
      .select('*')
      .order('payment_date', { ascending: false });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getPaymentsByAccount(accountId: string): Promise<LoanEMIPayment[]> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .select('*')
      .eq('account_id', accountId)
      .order('payment_number', { ascending: true });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getPaymentsByUser(userId: string): Promise<LoanEMIPayment[]> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .select('*')
      .eq('user_id', userId)
      .order('payment_date', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getPaymentByTransactionId(transactionId: string): Promise<LoanEMIPayment | null> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .select('*')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async createPayment(payment: Omit<LoanEMIPayment, 'id' | 'created_at' | 'updated_at'>): Promise<LoanEMIPayment> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .insert(payment)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create loan EMI payment');
    return data;
  },

  async createLoanEMIPayment(payment: Omit<LoanEMIPayment, 'id' | 'created_at' | 'updated_at'>): Promise<LoanEMIPayment> {
    return loanEMIPaymentApi.createPayment(payment);
  },

  async createBulkPayments(payments: Omit<LoanEMIPayment, 'id' | 'created_at' | 'updated_at'>[]): Promise<LoanEMIPayment[]> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .insert(payments)
      .select();

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async updatePayment(id: string, updates: Partial<LoanEMIPayment>): Promise<LoanEMIPayment> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to update loan EMI payment');
    return data;
  },

  async updatePaymentByTransactionId(transactionId: string, updates: Partial<LoanEMIPayment>): Promise<LoanEMIPayment> {
    const { data, error } = await supabase
      .from('loan_emi_payments')
      .update(updates)
      .eq('transaction_id', transactionId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to update loan EMI payment by transaction ID');
    return data;
  },

  async deletePayment(id: string): Promise<void> {
    const { error } = await supabase
      .from('loan_emi_payments')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async deletePaymentsByAccount(accountId: string): Promise<void> {
    const { error } = await supabase
      .from('loan_emi_payments')
      .delete()
      .eq('account_id', accountId);

    if (error) throw error;
  },

  async deletePaymentsByDate(accountId: string, date: string): Promise<void> {
    const { error } = await supabase
      .from('loan_emi_payments')
      .delete()
      .eq('account_id', accountId)
      .eq('payment_date', date);

    if (error) throw error;
  },

  async getTotalPrincipalPaid(accountId: string): Promise<number> {
    const { data, error } = await supabase
      .rpc('get_total_principal_paid', { p_account_id: accountId });

    if (error) throw error;
    return data || 0;
  },

  async getTotalInterestPaid(accountId: string): Promise<number> {
    const { data, error } = await supabase
      .rpc('get_total_interest_paid', { p_account_id: accountId });

    if (error) throw error;
    return data || 0;
  },

  async getLatestOutstandingPrincipal(accountId: string): Promise<number> {
    const { data, error } = await supabase
      .rpc('get_latest_outstanding_principal', { p_account_id: accountId });

    if (error) throw error;
    return data || 0;
  },

  async getNextPaymentNumber(accountId: string): Promise<number> {
    const { data, error } = await supabase
      .rpc('get_next_payment_number', { p_account_id: accountId });

    if (error) throw error;
    return data || 1;
  }
};

// Custom Bank Links API
export const customBankLinkApi = {
  async getCustomLink(userId: string, accountId: string) {
    const { data, error } = await supabase
      .from('custom_bank_links')
      .select('*')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getAllCustomLinks(userId: string) {
    const { data, error } = await supabase
      .from('custom_bank_links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async createCustomLink(customLink: {
    user_id: string;
    account_id: string;
    institution_name: string;
    app_name: string;
    app_url: string;
  }) {
    const { data, error } = await supabase
      .from('custom_bank_links')
      .insert(customLink)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateCustomLink(id: string, updates: {
    app_name?: string;
    app_url?: string;
  }) {
    const { data, error } = await supabase
      .from('custom_bank_links')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteCustomLink(id: string) {
    const { error } = await supabase
      .from('custom_bank_links')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
};

export const bankLinksApi = {
  async getAllBankLinks(): Promise<BankLink[]> {
    const { data, error } = await supabase
      .from('bank_links')
      .select('*')
      .eq('is_active', true)
      .order('country', { ascending: true })
      .order('bank_name', { ascending: true });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getBankLinksByCountry(country: string): Promise<BankLink[]> {
    const { data, error } = await supabase
      .from('bank_links')
      .select('*')
      .eq('country', country)
      .eq('is_active', true)
      .order('bank_name', { ascending: true });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async searchBankLinks(searchTerm: string): Promise<BankLink[]> {
    const { data, error } = await supabase
      .from('bank_links')
      .select('*')
      .ilike('bank_name', `%${searchTerm}%`)
      .eq('is_active', true)
      .order('bank_name', { ascending: true });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getBankLinkByName(bankName: string, country?: string): Promise<BankLink | null> {
    let query = supabase
      .from('bank_links')
      .select('*')
      .eq('bank_name', bankName)
      .eq('is_active', true);

    if (country) {
      query = query.eq('country', country);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    return data;
  },

  async createBankLink(bankLink: Omit<BankLink, 'id' | 'created_at' | 'updated_at'>): Promise<BankLink> {
    const { data, error } = await supabase
      .from('bank_links')
      .insert(bankLink)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateBankLink(id: string, updates: Partial<BankLink>): Promise<BankLink> {
    const { data, error } = await supabase
      .from('bank_links')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteBankLink(id: string) {
    const { error } = await supabase
      .from('bank_links')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
};

export const userCustomBankLinksApi = {
  async getUserCustomBankLinks(userId: string): Promise<UserCustomBankLink[]> {
    const { data, error } = await supabase
      .from('user_custom_bank_links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async getCustomBankLinksByAccount(accountId: string): Promise<UserCustomBankLink[]> {
    const { data, error } = await supabase
      .from('user_custom_bank_links')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  async createCustomBankLink(link: Omit<UserCustomBankLink, 'id' | 'created_at'>): Promise<UserCustomBankLink> {
    const { data, error } = await supabase
      .from('user_custom_bank_links')
      .insert(link)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateCustomBankLink(id: string, updates: Partial<UserCustomBankLink>): Promise<UserCustomBankLink> {
    const { data, error } = await supabase
      .from('user_custom_bank_links')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteCustomBankLink(id: string) {
    const { error } = await supabase
      .from('user_custom_bank_links')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
};

export const creditCardStatementApi = {
  // Automatically generate statement lines for active EMIs if the statement date has been reached
  async generateEMIStatementLines(userId: string): Promise<void> {
    try {
      // 1. Get all credit cards for this user
      const { data: accounts, error: accError } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('account_type', 'credit_card');

      if (accError) throw accError;
      if (!accounts || accounts.length === 0) return;

      // 2. Get active EMIs for this user
      const { data: activeEMIs, error: emiError } = await supabase
        .from('emi_transactions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (emiError) throw emiError;
      if (!activeEMIs || activeEMIs.length === 0) return;

      // 3. Get existing generated EMI statement lines to prevent duplicate inserts
      const { data: existingLines, error: linesError } = await supabase
        .from('credit_card_statement_lines')
        .select('emi_id, statement_month')
        .eq('user_id', userId)
        .is('transaction_id', null)
        .not('emi_id', 'is', null);

      if (linesError) throw linesError;

      const existingSet = new Set(
        (existingLines || []).map(l => `${l.emi_id}_${l.statement_month}`)
      );

      const today = new Date();
      const todayDay = today.getDate();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth();

      const formatLocalDateStr = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const getStatementMonthLocal = (dateStr: string, stmtDay: number): string => {
        const [yearStr, monthStr, dayStr] = dateStr.split('-');
        let year = parseInt(yearStr, 10);
        let month = parseInt(monthStr, 10) - 1;
        const dayOfMonth = parseInt(dayStr, 10);

        if (dayOfMonth > stmtDay) {
          month++;
          if (month > 11) {
            month = 0;
            year++;
          }
        }
        return `${year}-${String(month + 1).padStart(2, '0')}`;
      };

      const linesToInsert: any[] = [];

      for (const card of accounts) {
        const statementDay = card.statement_day;
        if (!statementDay) continue;

        // Calculate the latest statement date that has been generated
        let latestStatementDate: Date;
        if (todayDay >= statementDay) {
          latestStatementDate = new Date(currentYear, currentMonth, statementDay);
        } else {
          latestStatementDate = new Date(currentYear, currentMonth - 1, statementDay);
        }
        
        const latestStatementDateStr = formatLocalDateStr(latestStatementDate);

        // Filter active EMIs for this card
        const cardEMIs = activeEMIs.filter(emi => emi.account_id === card.id);

        for (const emi of cardEMIs) {
          // If EMI next_due_date is on or before the latest statement date
          if (emi.next_due_date && emi.next_due_date <= latestStatementDateStr) {
            const statementMonth = getStatementMonthLocal(emi.next_due_date, statementDay);
            const key = `${emi.id}_${statementMonth}`;

            if (!existingSet.has(key)) {
              const installmentNum = emi.emi_months - emi.remaining_installments + 1;
              const description = `EMI Installment: ${emi.description} (${installmentNum}/${emi.emi_months})`;

              linesToInsert.push({
                credit_card_id: card.id,
                user_id: userId,
                transaction_id: null,
                emi_id: emi.id,
                description,
                amount: emi.monthly_emi,
                transaction_date: emi.next_due_date,
                statement_month: statementMonth,
                status: 'pending',
                paid_amount: 0,
                currency: card.currency || 'INR'
              });
            }
          }
        }
      }

      if (linesToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from('credit_card_statement_lines')
          .insert(linesToInsert);

        if (insertError) throw insertError;
        console.log(`Auto-generated ${linesToInsert.length} EMI statement lines.`);
      }
    } catch (err) {
      console.error('Error auto-generating EMI statement lines:', err);
    }
  },

  // Get all statement lines for a specific month
  async getStatementLinesByMonth(
    creditCardId: string,
    statementMonth: string
  ): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('credit_card_id', creditCardId)
      .eq('statement_month', statementMonth)
      .order('transaction_date', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Get statement items (due transactions/EMIs) for a credit card in a given month
  async getStatementItems(
    creditCardId: string,
    statementMonth?: string // YYYY-MM format, defaults to current month
  ): Promise<any[]> {
    try {
      const card = await accountApi.getAccountById(creditCardId);
      if (card?.user_id) {
        await this.generateEMIStatementLines(card.user_id);
      }
    } catch (err) {
      console.error('Error running auto-generation in getStatementItems:', err);
    }

    const targetMonth = statementMonth || new Date().toISOString().slice(0, 7);

    // Get all transactions for this credit card from the statement month
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .or(`from_account_id.eq.${creditCardId},to_account_id.eq.${creditCardId}`)
      .gte('transaction_date', `${targetMonth}-01`)
      .lte('transaction_date', `${targetMonth}-31`);

    if (txError) throw txError;

    const { data: emis, error: emiError } = await supabase
      .from('emi_transactions')
      .select('*')
      .eq('account_id', creditCardId) // Fixed: was credit_card_id
      .in('status', ['active', 'paused']);

    if (emiError) throw emiError;

    // Get statement line items if they exist
    const { data: lines, error: lineError } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('credit_card_id', creditCardId)
      .eq('statement_month', targetMonth);

    if (lineError) throw lineError;

    // Merge and return statement items
    return [...(transactions || []), ...(emis || []), ...(lines || [])];
  },

  // Get all statement lines for a credit card (for a specific month or all unpaid)
  async getUnpaidStatementLines(creditCardId: string): Promise<any[]> {
    try {
      const card = await accountApi.getAccountById(creditCardId);
      if (card?.user_id) {
        await this.generateEMIStatementLines(card.user_id);
      }
    } catch (err) {
      console.error('Error running auto-generation in getUnpaidStatementLines:', err);
    }

    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('credit_card_id', creditCardId)
      .eq('status', 'pending')
      .order('transaction_date', { ascending: false });

    if (error) throw error;

    // FILTER: Hide transactions that have "EMI" in the description (purchases being converted)
    // But KEEP actual EMI installments (which should have emi_id set)
    const items = Array.isArray(data) ? data : [];
    return items.filter(item => {
      const hasEmiTag = item.description?.toLowerCase().includes('emi');
      // If it has "EMI" in description but NO emi_id, it's likely a purchase that shouldn't be selected here
      if (hasEmiTag && !item.emi_id) return false;
      return true;
    });
  },

  // Get all unpaid statement lines up to a specific date (for repayment selection)
  // This fetches ALL pending items from any period up to the statement date
  async getUnpaidStatementLinesUpToDate(creditCardId: string, endDate: string): Promise<any[]> {
    try {
      const card = await accountApi.getAccountById(creditCardId);
      if (card?.user_id) {
        await this.generateEMIStatementLines(card.user_id);
      }
    } catch (err) {
      console.error('Error running auto-generation in getUnpaidStatementLinesUpToDate:', err);
    }

    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('credit_card_id', creditCardId)
      .eq('status', 'pending')
      .lte('transaction_date', endDate)
      .order('transaction_date', { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Create a statement line item
  async createStatementLine(line: any): Promise<any> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .insert(line)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Update statement line payment status
  async updateStatementLineStatus(
    lineId: string,
    status: 'pending' | 'paid' | 'partial',
    paidAmount: number
  ): Promise<any> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .update({ status, paid_amount: paidAmount })
      .eq('id', lineId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Update arbitrary statement line fields (e.g. statement_month, transaction_date)
  async updateStatementLine(
    lineId: string,
    updates: Partial<any>
  ): Promise<any> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .update(updates)
      .eq('id', lineId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Get all statement lines for a user (for backup)
  async getAllStatementLines(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Get advance payment balance for a credit card (sum of all remaining balances)
  async getAdvanceBalance(creditCardId: string): Promise<number> {
    const { data, error } = await supabase
      .from('credit_card_advance_payments')
      .select('remaining_balance')
      .eq('credit_card_id', creditCardId)
      .gt('remaining_balance', 0);

    if (error) throw error;
    if (!data || data.length === 0) return 0;
    return data.reduce((sum, row) => sum + (row.remaining_balance || 0), 0);
  },

  // Get all advance payments for a user (for backup)
  async getAllAdvancePayments(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_advance_payments')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Consume advance balance (decrement from oldest records first - FIFO)
  async consumeAdvanceBalance(userId: string, creditCardId: string, amountToConsume: number): Promise<void> {
    const { data: records, error: fetchError } = await supabase
      .from('credit_card_advance_payments')
      .select('id, remaining_balance')
      .eq('credit_card_id', creditCardId)
      .eq('user_id', userId)
      .gt('remaining_balance', 0)
      .order('created_at', { ascending: true });

    if (fetchError) throw fetchError;
    if (!records || records.length === 0) return;

    let remaining = amountToConsume;
    for (const record of records) {
      if (remaining <= 0) break;
      const consume = Math.min(remaining, record.remaining_balance);
      const newBalance = record.remaining_balance - consume;
      remaining -= consume;

      const { error: updateError } = await supabase
        .from('credit_card_advance_payments')
        .update({
          remaining_balance: newBalance,
          updated_at: new Date().toISOString()
        })
        .eq('id', record.id);

      if (updateError) throw updateError;
    }
  },

  // Record advance payment
  async createAdvancePayment(
    userId: string,
    creditCardId: string,
    paymentAmount: number,
    currency: string,
    notes?: string,
    transactionId?: string
  ): Promise<any> {
    const { data, error } = await supabase
      .from('credit_card_advance_payments')
      .insert({
        user_id: userId,
        credit_card_id: creditCardId,
        payment_amount: paymentAmount,
        remaining_balance: paymentAmount,
        payment_date: new Date().toISOString(),
        currency,
        notes: notes || null,
        transaction_id: transactionId || null
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Get advance payment by transaction ID
  async getAdvancePaymentByTransactionId(transactionId: string): Promise<any> {
    const { data, error } = await supabase
      .from('credit_card_advance_payments')
      .select('*')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  // Update advance payment
  async updateAdvancePayment(id: string, updates: any): Promise<any> {
    const { data: existing, error: fetchError } = await supabase
      .from('credit_card_advance_payments')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!existing) throw new Error('Advance payment not found');

    let delta = 0;
    let newRemainingBalance = existing.remaining_balance;

    if (updates.payment_amount !== undefined && updates.payment_amount !== existing.payment_amount) {
      delta = updates.payment_amount - existing.payment_amount;
      newRemainingBalance = existing.remaining_balance + delta;
    }

    const { data, error } = await supabase
      .from('credit_card_advance_payments')
      .update({
        ...updates,
        remaining_balance: newRemainingBalance,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;



    return data;
  },

  // Delete advance payment
  async deleteAdvancePayment(id: string): Promise<void> {
    const { error } = await supabase
      .from('credit_card_advance_payments')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  // Update advance payment balance (e.g., when excess is used against future statement)
  // Consumes from oldest records first (FIFO)
  async updateAdvanceBalance(creditCardId: string, amount: number): Promise<void> {
    let remaining = amount;

    const { data: records, error: fetchError } = await supabase
      .from('credit_card_advance_payments')
      .select('id, remaining_balance')
      .eq('credit_card_id', creditCardId)
      .gt('remaining_balance', 0)
      .order('created_at', { ascending: true });

    if (fetchError) throw fetchError;
    if (!records || records.length === 0) return;

    for (const record of records) {
      if (remaining <= 0) break;
      const consume = Math.min(remaining, record.remaining_balance);
      const newBalance = record.remaining_balance - consume;
      remaining -= consume;

      const { error } = await supabase
        .from('credit_card_advance_payments')
        .update({ remaining_balance: newBalance, updated_at: new Date().toISOString() })
        .eq('id', record.id);

      if (error) throw error;
    }
  },

  // Delete allocations for a specific repayment
  async deleteAllocations(repaymentId: string): Promise<void> {
    const { error } = await supabase
      .from('credit_card_repayment_allocations')
      .delete()
      .eq('repayment_id', repaymentId);

    if (error) throw error;
  },

  // Allocate a repayment across multiple statement lines
  async allocateRepayment(
    repaymentId: string,
    allocations: Array<{
      line_id: string;
      amount: number;
      emi_id?: string;
    }>
  ): Promise<void> {
    const allocationRecords = allocations.map(alloc => ({
      repayment_id: repaymentId,
      statement_line_id: alloc.line_id,
      emi_id: alloc.emi_id || null,
      allocated_amount: alloc.amount,
      created_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('credit_card_repayment_allocations')
      .insert(allocationRecords);

    if (error) throw error;
  },

  // Get allocations for a specific repayment transaction
  async getRepaymentAllocations(repaymentId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_repayment_allocations')
      .select('*')
      .eq('repayment_id', repaymentId);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Get all repayment allocations for a user (for backup)
  async getAllRepaymentAllocations(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_repayment_allocations')
      .select('*, transactions!inner(user_id)')
      .eq('transactions.user_id', userId);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Get all repayment allocations with transaction dates for a user
  async getRepaymentAllocationsWithDates(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_repayment_allocations')
      .select('*, transactions!inner(transaction_date, user_id)')
      .eq('transactions.user_id', userId);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Manually add an EMI installment to statement lines
  async addEMIInstallmentToStatement(emiId: string, statementMonth: string): Promise<any> {
    const emi = await emiApi.getEMIById(emiId);
    if (!emi) throw new Error('EMI transaction not found');

    const card = await accountApi.getAccountById(emi.account_id);
    if (!card) throw new Error('Credit card account not found');

    const installmentNum = emi.emi_months - emi.remaining_installments + 1;
    const description = `EMI Installment: ${emi.description} (${installmentNum}/${emi.emi_months})`;

    const line = {
      credit_card_id: card.id,
      user_id: emi.user_id,
      transaction_id: null,
      emi_id: emi.id,
      description,
      amount: emi.monthly_emi,
      transaction_date: emi.next_due_date,
      statement_month: statementMonth,
      status: 'pending',
      paid_amount: 0,
      currency: card.currency || 'INR'
    };

    return await this.createStatementLine(line);
  },

  // Get statement lines by their IDs
  async getStatementLinesByIds(lineIds: string[]): Promise<any[]> {
    const { data, error } = await supabase
      .from('credit_card_statement_lines')
      .select('*')
      .in('id', lineIds);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  },

  // Reverse the effects of a credit card repayment
  async reverseRepayment(repaymentId: string): Promise<void> {
    // 1. Get all allocations for this repayment
    const allocations = await this.getRepaymentAllocations(repaymentId);

    // 2. Revert each allocation
    for (const alloc of allocations) {
      // Reset statement line status to pending and clear paid amount
      await this.updateStatementLineStatus(alloc.statement_line_id, 'pending', 0);

      // If it was an EMI installment, revert the installment payment
      if (alloc.emi_id) {
        try {
          const { data: emi } = await supabase.from('emi_transactions').select('*').eq('id', alloc.emi_id).maybeSingle();
          if (emi) {
            await emiApi.unpayEMIInstallment(alloc.emi_id);
          }
        } catch (err) {
          console.error(`Error reversing EMI installment ${alloc.emi_id}:`, err);
        }
      }
    }

    // 3. Revert Advance Balance effects
    // a. Delete advance payments CREATED by this repayment
    await supabase
      .from('credit_card_advance_payments')
      .delete()
      .ilike('notes', `%${repaymentId}%`);

    // b. Revert advance balance CONSUMED (Add back to advance balance)
    const totalAllocated = allocations.reduce((sum, a) => sum + a.allocated_amount, 0);
    const { data: repaymentTx } = await supabase
      .from('transactions')
      .select('amount, user_id, to_account_id, currency')
      .eq('id', repaymentId)
      .maybeSingle();

    if (repaymentTx) {
      const repaymentAmount = Number(repaymentTx.amount);
      const advanceUsed = Math.max(0, totalAllocated - repaymentAmount);

      if (advanceUsed > 0 && repaymentTx.to_account_id) {
        // Create a reversal record to add the balance back
        await this.createAdvancePayment(
          repaymentTx.user_id,
          repaymentTx.to_account_id,
          advanceUsed,
          repaymentTx.currency,
          `Reversal of advance balance used in repayment ${repaymentId}`
        );
      }
    }

    // 4. Finally delete the allocation records themselves
    await this.deleteAllocations(repaymentId);
  }
};
