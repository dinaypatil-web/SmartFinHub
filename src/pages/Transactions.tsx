import { useEffect, useState, useMemo } from 'react';
import { useHybridAuth as useAuth } from '@/contexts/HybridAuthContext';
import { transactionApi, accountApi, categoryApi } from '@/db/api';
import type { Transaction, Account, ExpenseCategory } from '@/types/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency, formatDate } from '@/utils/format';
import {
  Plus,
  Edit,
  Trash2,
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Search,
  SlidersHorizontal,
  X,
  Sparkles,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { cache } from '@/utils/cache';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function Transactions() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState<Transaction | null>(null);

  // Filter States
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [datePreset, setDatePreset] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sortBy, setSortBy] = useState<string>('date-desc');
  const [isFiltersExpanded, setIsFiltersExpanded] = useState(false);


  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      const [transactionsData, accountsData, categoriesData] = await Promise.all([
        transactionApi.getTransactions(user.id),
        accountApi.getAccounts(user.id),
        categoryApi.getCategories(user.id),
      ]);
      setTransactions(transactionsData);
      setAccounts(accountsData);
      setCategories(categoriesData);
    } catch (error) {
      console.error('Error loading transaction data:', error);
      toast({
        title: 'Error',
        description: 'Failed to load transaction data',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!transactionToDelete) return;

    try {
      await transactionApi.deleteTransaction(transactionToDelete.id);
      
      // Clear dashboard cache to reflect deleted transaction
      cache.clearPattern('dashboard-');
      
      toast({
        title: 'Success',
        description: 'Transaction deleted successfully',
      });
      loadData();
    } catch (error) {
      console.error('Error deleting transaction:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete transaction',
        variant: 'destructive',
      });
    } finally {
      setDeleteDialogOpen(false);
      setTransactionToDelete(null);
    }
  };

  const filteredAndSortedTransactions = useMemo(() => {
    return transactions
      .filter((transaction) => {
        // 1. Search Query (Matches description or category or type or splits)
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          const desc = (transaction.description || '').toLowerCase();
          const cat = (transaction.category || '').toLowerCase();
          const incCat = (transaction.income_category || '').toLowerCase();
          const type = (transaction.transaction_type || '').toLowerCase();
          const inSplits = transaction.transaction_splits && transaction.transaction_splits.some(
            s => s.category.toLowerCase().includes(query) || (s.description || '').toLowerCase().includes(query)
          );
          if (
            !desc.includes(query) &&
            !cat.includes(query) &&
            !incCat.includes(query) &&
            !type.includes(query) &&
            !inSplits
          ) {
            return false;
          }
        }

        // 2. Transaction Type
        if (filterType !== 'all') {
          if (transaction.transaction_type !== filterType) {
            return false;
          }
        }

        // 3. Account (from_account_id or to_account_id matches)
        if (filterAccount !== 'all') {
          if (
            transaction.from_account_id !== filterAccount &&
            transaction.to_account_id !== filterAccount
          ) {
            return false;
          }
        }

        // 4. Category (matches category or income_category or splits)
        if (filterCategory !== 'all') {
          const hasSplitMatch = transaction.transaction_splits && transaction.transaction_splits.some(
            s => s.category.toLowerCase() === filterCategory.toLowerCase()
          );
          const transactionCat = transaction.category || transaction.income_category;
          
          if (!hasSplitMatch && (!transactionCat || transactionCat.toLowerCase() !== filterCategory.toLowerCase())) {
            return false;
          }
        }

        // 5. Date Range
        if (datePreset !== 'all') {
          const txDate = new Date(transaction.transaction_date);
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          if (datePreset === 'today') {
            const txDay = new Date(txDate);
            txDay.setHours(0, 0, 0, 0);
            if (txDay.getTime() !== today.getTime()) return false;
          } else if (datePreset === 'yesterday') {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const txDay = new Date(txDate);
            txDay.setHours(0, 0, 0, 0);
            if (txDay.getTime() !== yesterday.getTime()) return false;
          } else if (datePreset === 'last-7-days') {
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            if (txDate < sevenDaysAgo) return false;
          } else if (datePreset === 'last-30-days') {
            const thirtyDaysAgo = new Date(today);
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            if (txDate < thirtyDaysAgo) return false;
          } else if (datePreset === 'this-month') {
            const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            if (txDate < startOfMonth) return false;
          } else if (datePreset === 'last-month') {
            const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
            if (txDate < startOfLastMonth || txDate > endOfLastMonth) return false;
          } else if (datePreset === 'custom') {
            if (startDate) {
              const start = new Date(startDate);
              start.setHours(0, 0, 0, 0);
              if (txDate < start) return false;
            }
            if (endDate) {
              const end = new Date(endDate);
              end.setHours(23, 59, 59, 999);
              if (txDate > end) return false;
            }
          }
        }

        // 6. Amount Range
        const amt = Number(transaction.amount);
        if (minAmount !== '') {
          const min = parseFloat(minAmount);
          if (!isNaN(min) && amt < min) return false;
        }
        if (maxAmount !== '') {
          const max = parseFloat(maxAmount);
          if (!isNaN(max) && amt > max) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // 7. Sort By
        if (sortBy === 'date-desc') {
          const dateA = new Date(a.transaction_date).getTime();
          const dateB = new Date(b.transaction_date).getTime();
          if (dateB !== dateA) return dateB - dateA;
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        } else if (sortBy === 'date-asc') {
          const dateA = new Date(a.transaction_date).getTime();
          const dateB = new Date(b.transaction_date).getTime();
          if (dateA !== dateB) return dateA - dateB;
          return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        } else if (sortBy === 'amount-desc') {
          return Number(b.amount) - Number(a.amount);
        } else if (sortBy === 'amount-asc') {
          return Number(a.amount) - Number(b.amount);
        }
        return 0;
      });
  }, [
    transactions,
    searchQuery,
    filterType,
    filterAccount,
    filterCategory,
    datePreset,
    startDate,
    endDate,
    minAmount,
    maxAmount,
    sortBy,
  ]);

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (searchQuery.trim()) count++;
    if (filterType !== 'all') count++;
    if (filterAccount !== 'all') count++;
    if (filterCategory !== 'all') count++;
    if (datePreset !== 'all') count++;
    if (minAmount !== '') count++;
    if (maxAmount !== '') count++;
    return count;
  }, [
    searchQuery,
    filterType,
    filterAccount,
    filterCategory,
    datePreset,
    minAmount,
    maxAmount,
  ]);

  const handleResetFilters = () => {
    setSearchQuery('');
    setFilterType('all');
    setFilterAccount('all');
    setFilterCategory('all');
    setDatePreset('all');
    setStartDate('');
    setEndDate('');
    setMinAmount('');
    setMaxAmount('');
    setSortBy('date-desc');
  };

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'income':
        return <ArrowDownRight className="h-4 w-4 text-success" />;
      case 'expense':
        return <ArrowUpRight className="h-4 w-4 text-danger" />;
      case 'transfer':
        return <ArrowLeftRight className="h-4 w-4 text-primary" />;
      default:
        return <ArrowLeftRight className="h-4 w-4" />;
    }
  };

  const getTransactionBadgeVariant = (type: string) => {
    switch (type) {
      case 'income':
        return 'default';
      case 'expense':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-12 w-64 bg-muted" />
        <Skeleton className="h-96 bg-muted" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-full overflow-x-hidden">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Transactions</h1>
          <p className="text-sm text-muted-foreground">View and manage your transactions</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <Link to="/voice-transact?intent=transaction" className="flex-1 sm:flex-none">
            <Button className="w-full bg-primary hover:bg-primary/90 text-white shadow-md transition-all text-xs sm:text-sm">
              <Sparkles className="mr-2 h-4 w-4 text-white animate-pulse" />
              Ask AI Assistant
            </Button>
          </Link>
          <Link to="/transactions/new" className="flex-1 sm:flex-none">
            <Button className="w-full text-xs sm:text-sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Transaction
            </Button>
          </Link>
        </div>
      </div>

      {transactions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ArrowLeftRight className="h-16 w-16 text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold mb-2">No transactions yet</h3>
            <p className="text-muted-foreground mb-4">Add your first transaction to get started</p>
            <Link to="/transactions/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Transaction
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Quick filter badges row */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-2 px-2 scrollbar-none">
            <Badge
              variant={filterType === 'all' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium transition-all"
              onClick={() => setFilterType('all')}
            >
              All Transactions
            </Badge>
            <Badge
              variant={filterType === 'income' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted transition-all"
              onClick={() => setFilterType('income')}
            >
              Income
            </Badge>
            <Badge
              variant={filterType === 'expense' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted transition-all"
              onClick={() => setFilterType('expense')}
            >
              Expense
            </Badge>
            <Badge
              variant={filterType === 'transfer' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted transition-all"
              onClick={() => setFilterType('transfer')}
            >
              Transfer
            </Badge>
            <Badge
              variant={filterType === 'loan_payment' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted transition-all"
              onClick={() => setFilterType('loan_payment')}
            >
              Loan Payments
            </Badge>
            <Badge
              variant={filterType === 'credit_card_repayment' ? 'default' : 'outline'}
              className="cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted transition-all"
              onClick={() => setFilterType('credit_card_repayment')}
            >
              Credit Card Repayments
            </Badge>
          </div>

          {/* Search & Sliders Filter Controls Bar */}
          <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by description or category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-10"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1 top-1/2 transform -translate-y-1/2 h-8 w-8 p-0 hover:bg-transparent"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Quick buttons */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Button
                variant={isFiltersExpanded ? 'secondary' : 'outline'}
                onClick={() => setIsFiltersExpanded(!isFiltersExpanded)}
                className="flex items-center gap-2"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>Advanced Filters</span>
                {activeFiltersCount > 0 && (
                  <Badge
                    variant="default"
                    className="ml-1 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground font-semibold"
                  >
                    {activeFiltersCount}
                  </Badge>
                )}
              </Button>

              {activeFiltersCount > 0 && (
                <Button
                  variant="ghost"
                  onClick={handleResetFilters}
                  className="text-muted-foreground text-sm hover:text-foreground"
                >
                  Reset
                </Button>
              )}
            </div>
          </div>

          {/* Advanced Collapsible Filter Panel */}
          {isFiltersExpanded && (
            <Card className="bg-card/50 backdrop-blur-sm border-dashed">
              <CardContent className="pt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {/* Type Selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Type
                  </Label>
                  <Select value={filterType} onValueChange={setFilterType}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="income">Income</SelectItem>
                      <SelectItem value="expense">Expense</SelectItem>
                      <SelectItem value="transfer">Transfer</SelectItem>
                      <SelectItem value="withdrawal">Withdrawal</SelectItem>
                      <SelectItem value="loan_payment">Loan Payment</SelectItem>
                      <SelectItem value="credit_card_repayment">Credit Card Repayment</SelectItem>
                      <SelectItem value="interest_charge">Interest Charge</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Account Selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Account
                  </Label>
                  <Select value={filterAccount} onValueChange={setFilterAccount}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Accounts" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Accounts</SelectItem>
                      {accounts.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id}>
                          {acc.account_name} ({acc.institution_name})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Category Selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Category
                  </Label>
                  <Select value={filterCategory} onValueChange={setFilterCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Categories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={cat.name}>
                          {cat.icon} {cat.name}
                        </SelectItem>
                      ))}
                      {Array.from(
                        new Set(
                          transactions
                            .map((tx) => tx.category || tx.income_category)
                            .filter((c): c is string => !!c)
                        )
                      )
                        .filter(
                          (c) =>
                            !categories.some(
                              (cat) => cat.name.toLowerCase() === c.toLowerCase()
                            )
                        )
                        .map((c) => (
                          <SelectItem key={c} value={c}>
                            📁 {c}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Date Range Preset Selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Date Period
                  </Label>
                  <Select value={datePreset} onValueChange={setDatePreset}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Time" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Time</SelectItem>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="yesterday">Yesterday</SelectItem>
                      <SelectItem value="last-7-days">Last 7 Days</SelectItem>
                      <SelectItem value="last-30-days">Last 30 Days</SelectItem>
                      <SelectItem value="this-month">This Month</SelectItem>
                      <SelectItem value="last-month">Last Month</SelectItem>
                      <SelectItem value="custom">Custom Range</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Custom Date Pickers (Conditional) */}
                {datePreset === 'custom' && (
                  <div className="space-y-2 sm:col-span-2 grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        From Date
                      </Label>
                      <Input
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        To Date
                      </Label>
                      <Input
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Amount Min Input */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Min Amount
                  </Label>
                  <Input
                    type="number"
                    placeholder="Min"
                    value={minAmount}
                    onChange={(e) => setMinAmount(e.target.value)}
                  />
                </div>

                {/* Amount Max Input */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Max Amount
                  </Label>
                  <Input
                    type="number"
                    placeholder="Max"
                    value={maxAmount}
                    onChange={(e) => setMaxAmount(e.target.value)}
                  />
                </div>

                {/* Sort Selector */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Sort By
                  </Label>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger>
                      <SelectValue placeholder="Newest First" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date-desc">Newest First</SelectItem>
                      <SelectItem value="date-asc">Oldest First</SelectItem>
                      <SelectItem value="amount-desc">Amount: High to Low</SelectItem>
                      <SelectItem value="amount-asc">Amount: Low to High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Active Filter Badges */}
          {activeFiltersCount > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-semibold text-xs uppercase tracking-wider mr-1">
                Active filters:
              </span>
              {searchQuery.trim() && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Search: {searchQuery}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setSearchQuery('')} />
                </Badge>
              )}
              {filterType !== 'all' && (
                <Badge variant="secondary" className="flex items-center gap-1 capitalize">
                  Type: {filterType}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setFilterType('all')} />
                </Badge>
              )}
              {filterAccount !== 'all' && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Account: {accounts.find((a) => a.id === filterAccount)?.account_name || 'Selected'}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setFilterAccount('all')} />
                </Badge>
              )}
              {filterCategory !== 'all' && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Category: {filterCategory}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setFilterCategory('all')} />
                </Badge>
              )}
              {datePreset !== 'all' && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Date:{' '}
                  {datePreset === 'custom'
                    ? `${startDate || 'Start'} to ${endDate || 'End'}`
                    : datePreset.replace('-', ' ')}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setDatePreset('all')} />
                </Badge>
              )}
              {minAmount !== '' && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Min: {minAmount}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setMinAmount('')} />
                </Badge>
              )}
              {maxAmount !== '' && (
                <Badge variant="secondary" className="flex items-center gap-1">
                  Max: {maxAmount}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setMaxAmount('')} />
                </Badge>
              )}
              <Button
                variant="link"
                size="sm"
                onClick={handleResetFilters}
                className="h-auto p-0 text-xs font-semibold text-danger hover:no-underline"
              >
                Clear all
              </Button>
            </div>
          )}

          {filteredAndSortedTransactions.length === 0 ? (
            <Card className="border-dashed py-12">
              <CardContent className="flex flex-col items-center justify-center text-center space-y-4">
                <div className="p-3 bg-muted rounded-full text-muted-foreground">
                  <Search className="h-8 w-8" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-semibold">No matching transactions</h3>
                  <p className="text-muted-foreground max-w-sm">
                    We couldn't find any transactions matching your current filters. Try resetting them.
                  </p>
                </div>
                <Button onClick={handleResetFilters} variant="secondary">
                  Reset Filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0 pb-4">
                <CardTitle>All Transactions</CardTitle>
                <div className="text-sm text-muted-foreground font-medium">
                  Showing {filteredAndSortedTransactions.length} of {transactions.length} transactions
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:p-6">
                <div className="w-full overflow-x-auto touch-pan-x scrollbar-thin">
                  <Table className="min-w-[650px] sm:min-w-[750px] w-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">Date</TableHead>
                        <TableHead className="whitespace-nowrap">Type</TableHead>
                        <TableHead className="whitespace-nowrap">Description</TableHead>
                        <TableHead className="whitespace-nowrap">Category</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Amount</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAndSortedTransactions.map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell className="whitespace-nowrap">{formatDate(transaction.transaction_date)}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {getTransactionIcon(transaction.transaction_type)}
                              <Badge variant={getTransactionBadgeVariant(transaction.transaction_type)}>
                                {transaction.transaction_type}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-xs">
                            <div className="break-words line-clamp-2">
                              {transaction.description || '-'}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-xs">
                            <div className="break-words">
                              {transaction.transaction_splits && transaction.transaction_splits.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                  <span className="text-[10px] font-bold text-purple-700 dark:text-purple-400">
                                    Split ({transaction.transaction_splits.length}):
                                  </span>
                                  <div className="flex flex-wrap gap-1">
                                    {transaction.transaction_splits.map((s, idx) => (
                                      <Badge key={s.id || idx} variant="outline" className="text-[9px] py-0 px-1.5 border-purple-200 bg-purple-50/30 text-slate-700 dark:text-slate-300 dark:border-purple-900/50">
                                        {s.category}: {formatCurrency(s.amount, transaction.currency)}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                transaction.category || '-'
                              )}
                            </div>
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold whitespace-nowrap ${
                              transaction.transaction_type === 'income' ? 'text-success' : 'text-danger'
                            }`}
                          >
                            {transaction.transaction_type === 'income' ? '+' : '-'}
                            {formatCurrency(Number(transaction.amount), transaction.currency)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <div className="flex justify-end gap-1 sm:gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/transactions/edit/${transaction.id}`)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setTransactionToDelete(transaction);
                                  setDeleteDialogOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4 text-danger" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Transaction</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this transaction? This action cannot be undone and will affect account balances.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-danger text-danger-foreground hover:bg-danger/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
