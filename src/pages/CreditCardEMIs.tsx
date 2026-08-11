import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHybridAuth as useAuth } from '@/contexts/HybridAuthContext';
import { accountApi, emiApi, creditCardStatementApi } from '@/db/api';
import type { Account, EMITransaction } from '@/types/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Calendar, CreditCard, TrendingUp, AlertCircle, RefreshCw, CheckCircle2, PlusCircle, ArrowLeft, Clock } from 'lucide-react';
import { formatCurrency } from '@/utils/format';
import { calculateFirstEMIDueDate } from '@/utils/emiCalculations';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface InstallmentItem {
  id: string;
  emiId: string;
  description: string;
  cardName: string;
  cardId: string;
  installmentNum: number;
  totalInstallments: number;
  statementMonth: string;
  statementDate: Date;
  dueDate: string;
  paymentDate: string | null;
  amount: number;
  status: 'paid' | 'pending' | 'partial' | 'not_generated' | 'upcoming';
  currency: string;
  isGenerated: boolean;
}

export default function CreditCardEMIs() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  
  // Data States
  const [creditCards, setCreditCards] = useState<Account[]>([]);
  const [emis, setEmis] = useState<EMITransaction[]>([]);
  const [statementLines, setStatementLines] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  
  // Filter States
  const [selectedCardId, setSelectedCardId] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Date utilities
  const parseLocalDate = (dateStr: string): Date => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  };

  const getStatementMonthLocal = (dateStr: string, stmtDay: number): string => {
    const [year, monthVal, dayVal] = dateStr.split('-').map(Number);
    let month = monthVal - 1;
    let y = year;

    if (dayVal > stmtDay) {
      month++;
      if (month > 11) {
        month = 0;
        y++;
      }
    }
    return `${y}-${String(month + 1).padStart(2, '0')}`;
  };

  const getStatementDateForMonth = (monthStr: string, statementDay: number): Date => {
    const [year, month] = monthStr.split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    const safeDay = Math.min(statementDay, lastDay);
    return new Date(year, month - 1, safeDay);
  };

  const formatStatementMonth = (monthStr: string) => {
    if (!monthStr) return '';
    const [year, month] = monthStr.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  const formatDate = (dateInput: string | Date | null) => {
    if (!dateInput) return '-';
    const date = typeof dateInput === 'string' ? parseLocalDate(dateInput) : dateInput;
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const loadData = async () => {
    if (!user?.id) return;
    
    try {
      setLoading(true);
      
      const [accountsData, emisData, statementLinesData, allocationsData] = await Promise.all([
        accountApi.getAccounts(user.id),
        emiApi.getEMIsByUser(user.id),
        creditCardStatementApi.getAllStatementLines(user.id),
        creditCardStatementApi.getRepaymentAllocationsWithDates(user.id),
      ]);

      const cards = accountsData.filter((acc: Account) => acc.account_type === 'credit_card');
      setCreditCards(cards);
      
      // Filter EMIs to only keep those linked to credit cards
      const cardIds = new Set(cards.map(c => c.id));
      let cardEmis = emisData.filter((emi: EMITransaction) => cardIds.has(emi.account_id));

      // Self-heal logic for active EMIs with miscalculated next_due_date or misattributed statement lines
      let hasFixedAny = false;
      for (const emi of cardEmis) {
        if (emi.status === 'active') {
          const card = cards.find(c => c.id === emi.account_id);
          if (!card) continue;
          const stmtDay = card.statement_day || 15;
          
          // Calculate what the correct first due date should be
          const correctFirstDueDateStr = calculateFirstEMIDueDate(emi.start_date, stmtDay);
          
          // Calculate correct next due date based on paid installments
          const paidInstallments = emi.emi_months - emi.remaining_installments;
          const [fY, fM] = correctFirstDueDateStr.split('-').map(Number);
          const correctNextDueDateObj = new Date(fY, fM - 1 + paidInstallments, 1);
          const lastDay = new Date(correctNextDueDateObj.getFullYear(), correctNextDueDateObj.getMonth() + 1, 0).getDate();
          const safeDay = Math.min(stmtDay, lastDay);
          correctNextDueDateObj.setDate(safeDay);
          
          const cY = correctNextDueDateObj.getFullYear();
          const cM = String(correctNextDueDateObj.getMonth() + 1).padStart(2, '0');
          const cD = String(correctNextDueDateObj.getDate()).padStart(2, '0');
          const correctNextDueDateStr = `${cY}-${cM}-${cD}`;
          
          if (emi.next_due_date !== correctNextDueDateStr) {
            console.log(`Self-healing EMI "${emi.description}": next_due_date corrected from ${emi.next_due_date} to ${correctNextDueDateStr}`);
            await emiApi.updateEMI(emi.id, { next_due_date: correctNextDueDateStr });
            hasFixedAny = true;
          }

          // Heal any existing statement lines for this EMI that have incorrect statement_month (e.g., previous month)
          const expectedFirstStmtMonth = getStatementMonthLocal(correctFirstDueDateStr, stmtDay);
          const emiLines = statementLinesData.filter((line: any) => line.emi_id === emi.id);
          for (const line of emiLines) {
            if (line.statement_month < expectedFirstStmtMonth && line.status !== 'paid') {
              console.log(`Self-healing statement line "${line.id}": statement_month corrected from ${line.statement_month} to ${expectedFirstStmtMonth}`);
              await creditCardStatementApi.updateStatementLine(line.id, {
                statement_month: expectedFirstStmtMonth,
                transaction_date: correctFirstDueDateStr,
              });
              hasFixedAny = true;
            }
          }
        }
      }

      if (hasFixedAny) {
        // Reload EMIs & statement lines if we patched any
        const [updatedEmisData, updatedStatementLinesData] = await Promise.all([
          emiApi.getEMIsByUser(user.id),
          creditCardStatementApi.getAllStatementLines(user.id),
        ]);
        cardEmis = updatedEmisData.filter((emi: EMITransaction) => cardIds.has(emi.account_id));
        setStatementLines(updatedStatementLinesData);
      } else {
        setStatementLines(statementLinesData);
      }

      setEmis(cardEmis);
      setAllocations(allocationsData);
    } catch (err) {
      console.error('Error loading EMI page data:', err);
      toast({
        title: 'Error',
        description: 'Failed to load Credit Card EMI data.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  // Handle manual addition to statement
  const handleAddToStatement = async (emiId: string, statementMonth: string, virtualId: string) => {
    setActionLoading(virtualId);
    try {
      await creditCardStatementApi.addEMIInstallmentToStatement(emiId, statementMonth);
      toast({
        title: 'Installment Added',
        description: 'The EMI installment has been successfully added to your statement lines.',
      });
      await loadData();
    } catch (err) {
      console.error('Error adding EMI to statement:', err);
      toast({
        title: 'Error',
        description: 'Failed to add EMI installment to statement.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Build the list of all installments (both generated and projected/virtual)
  const buildInstallmentsList = (): InstallmentItem[] => {
    const list: InstallmentItem[] = [];
    const todayStr = new Date().toISOString().split('T')[0];

    emis.forEach(emi => {
      const card = creditCards.find(c => c.id === emi.account_id);
      if (!card) return;

      const stmtDay = card.statement_day || 15;
      const currency = card.currency || 'INR';
      const emiLines = statementLines.filter(line => line.emi_id === emi.id);

      // Determine correct first due date string for installment 1
      const firstDueDateStr = calculateFirstEMIDueDate(emi.start_date, stmtDay);

      for (let instNum = 1; instNum <= emi.emi_months; instNum++) {
        const monthsOffset = instNum - 1;

        // Calculate expected due date for installment N based on firstDueDateStr
        const [fY, fM] = firstDueDateStr.split('-').map(Number);
        const expectedDueDateObj = new Date(fY, fM - 1 + monthsOffset, 1);
        const lastDay = new Date(expectedDueDateObj.getFullYear(), expectedDueDateObj.getMonth() + 1, 0).getDate();
        const safeDay = Math.min(stmtDay, lastDay);
        expectedDueDateObj.setDate(safeDay);

        const ey = expectedDueDateObj.getFullYear();
        const em = String(expectedDueDateObj.getMonth() + 1).padStart(2, '0');
        const ed = String(expectedDueDateObj.getDate()).padStart(2, '0');
        const expectedDueDateStr = `${ey}-${em}-${ed}`;

        const expectedStmtMonth = getStatementMonthLocal(expectedDueDateStr, stmtDay);

        // Check if statement line already exists for this month
        const existingLine = emiLines.find(line => line.statement_month === expectedStmtMonth);

        if (existingLine) {
          // Find allocation payment date
          const alloc = allocations.find(a => a.statement_line_id === existingLine.id);
          const paymentDate = existingLine.status === 'paid' && alloc?.transactions?.transaction_date
            ? alloc.transactions.transaction_date
            : null;

          list.push({
            id: existingLine.id,
            emiId: emi.id,
            description: emi.description || 'Credit Card EMI',
            cardName: card.name,
            cardId: card.id,
            installmentNum: instNum,
            totalInstallments: emi.emi_months,
            statementMonth: expectedStmtMonth,
            statementDate: getStatementDateForMonth(expectedStmtMonth, stmtDay),
            dueDate: expectedDueDateStr,
            paymentDate,
            amount: Number(existingLine.amount),
            status: existingLine.status,
            currency,
            isGenerated: true,
          });
        } else {
          // Not generated in DB
          const isDueOrPassed = expectedDueDateStr <= todayStr;
          const status = isDueOrPassed ? 'not_generated' : 'upcoming';

          list.push({
            id: `virtual-${emi.id}-${expectedStmtMonth}`,
            emiId: emi.id,
            description: emi.description || 'Credit Card EMI',
            cardName: card.name,
            cardId: card.id,
            installmentNum: instNum,
            totalInstallments: emi.emi_months,
            statementMonth: expectedStmtMonth,
            statementDate: getStatementDateForMonth(expectedStmtMonth, stmtDay),
            dueDate: expectedDueDateStr,
            paymentDate: null,
            amount: emi.monthly_emi,
            status,
            currency,
            isGenerated: false,
          });
        }
      }
    });

    // Sort: newest statement date first, then by installment number
    return list.sort((a, b) => b.statementDate.getTime() - a.statementDate.getTime() || b.installmentNum - a.installmentNum);
  };

  const allInstallments = buildInstallmentsList();

  // Filtered Installments
  const filteredInstallments = allInstallments.filter(item => {
    const matchesCard = selectedCardId === 'all' || item.cardId === selectedCardId;
    
    let matchesStatus = true;
    if (selectedStatus === 'unpaid') {
      matchesStatus = item.status === 'pending' || item.status === 'partial';
    } else if (selectedStatus !== 'all') {
      matchesStatus = item.status === selectedStatus;
    }

    const matchesSearch = item.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          item.cardName.toLowerCase().includes(searchTerm.toLowerCase());

    return matchesCard && matchesStatus && matchesSearch;
  });

  // Calculate high-level stats
  const activeEMIs = emis.filter(e => e.status === 'active');
  const totalMonthlyOutflow = activeEMIs.reduce((sum, e) => sum + e.monthly_emi, 0);
  const totalRemainingLiability = activeEMIs.reduce((sum, e) => sum + (e.remaining_installments * e.monthly_emi), 0);
  
  // Highlighted EMIs are those that are generated (isGenerated === true) but unpaid
  const unpaidGeneratedCount = allInstallments.filter(item => item.isGenerated && (item.status === 'pending' || item.status === 'partial')).length;

  if (loading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading credit card EMIs...</span>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
            <CreditCard className="h-8 w-8 text-primary" />
            Credit Card EMIs
          </h1>
          <p className="text-muted-foreground mt-1">
            Track, generate, and manage statement lines for your credit card EMI purchases.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} className="w-fit">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active EMI Plans</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeEMIs.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Currently running EMI conversions
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Outflow</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(totalMonthlyOutflow, creditCards[0]?.currency || 'INR')}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Combined EMI dues per month
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Remaining Liability</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(totalRemainingLiability, creditCards[0]?.currency || 'INR')}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Total future EMI payments due
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow border-amber-200 dark:border-amber-950 bg-amber-50/20 dark:bg-amber-950/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-amber-800 dark:text-amber-400">Unpaid Statements</CardTitle>
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-800 dark:text-amber-400">{unpaidGeneratedCount}</div>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
              Generated in statements, unpaid
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="installments" className="w-full">
        <TabsList className="grid w-full max-w-[400px] grid-cols-2">
          <TabsTrigger value="installments">Installments Tracker</TabsTrigger>
          <TabsTrigger value="plans">Active EMI Plans</TabsTrigger>
        </TabsList>

        <TabsContent value="installments" className="space-y-6 pt-4">
          {/* Filters */}
          <div className="flex flex-col md:flex-row gap-4 items-end md:items-center justify-between bg-card p-4 rounded-lg border">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full md:w-auto">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">Search</span>
                <Input
                  placeholder="Filter by description..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full sm:w-[200px]"
                />
              </div>

              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">Credit Card</span>
                <Select value={selectedCardId} onValueChange={setSelectedCardId}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="All Cards" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Cards</SelectItem>
                    {creditCards.map(card => (
                      <SelectItem key={card.id} value={card.id}>{card.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground">Status</span>
                <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="unpaid">Unpaid (Generated)</SelectItem>
                    <SelectItem value="not_generated">Not Generated (Due)</SelectItem>
                    <SelectItem value="upcoming">Upcoming</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="border rounded-lg bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Credit Card</TableHead>
                  <TableHead>EMI Description</TableHead>
                  <TableHead>Installment</TableHead>
                  <TableHead>Statement Month</TableHead>
                  <TableHead>Statement Date</TableHead>
                  <TableHead>Payment Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInstallments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      No installments found matching the selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredInstallments.map((item) => {
                    const isUnpaidGenerated = item.isGenerated && (item.status === 'pending' || item.status === 'partial');
                    
                    return (
                      <TableRow 
                        key={item.id}
                        className={
                          isUnpaidGenerated 
                            ? 'bg-destructive/5 hover:bg-destructive/10 dark:bg-destructive/10 dark:hover:bg-destructive/20 border-l-4 border-l-destructive' 
                            : ''
                        }
                      >
                        <TableCell className="font-semibold">{item.cardName}</TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">{item.description}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono">
                            {item.installmentNum} / {item.totalInstallments}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatStatementMonth(item.statementMonth)}</TableCell>
                        <TableCell className="font-mono text-xs">{formatDate(item.statementDate)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {item.paymentDate ? (
                            <span className="text-green-600 dark:text-green-400 flex items-center gap-1">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {formatDate(item.paymentDate)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-bold text-foreground">
                          {formatCurrency(item.amount, item.currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge className={
                            item.status === 'paid'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                              : item.status === 'partial'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                                : item.status === 'pending'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                  : item.status === 'not_generated'
                                    ? 'bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400 border border-slate-300'
                                    : 'bg-blue-55 text-blue-700 dark:bg-blue-950/20 dark:text-blue-400'
                          }>
                            {item.status === 'not_generated' ? 'NOT GENERATED' : item.status.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {item.status === 'not_generated' ? (
                            <Button 
                              size="sm" 
                              variant="default"
                              className="bg-primary hover:bg-primary/95 text-primary-foreground flex items-center gap-1"
                              disabled={actionLoading === item.id}
                              onClick={() => handleAddToStatement(item.emiId, item.statementMonth, item.id)}
                            >
                              {actionLoading === item.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <PlusCircle className="h-3.5 w-3.5" />
                              )}
                              Add to Statement
                            </Button>
                          ) : item.status === 'pending' || item.status === 'partial' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => navigate('/reports')}
                              className="hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              View & Pay
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="plans" className="space-y-6 pt-4">
          {emis.length === 0 ? (
            <Alert className="bg-card">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You have no active or historical credit card EMI conversions set up.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {emis.map(emi => {
                const card = creditCards.find(c => c.id === emi.account_id);
                const paidInstallments = emi.emi_months - emi.remaining_installments;
                const progressPercent = (paidInstallments / emi.emi_months) * 100;
                
                return (
                  <Card key={emi.id} className="hover:shadow-lg transition-shadow flex flex-col justify-between">
                    <CardHeader className="pb-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-bold text-lg leading-tight text-foreground">{emi.description || 'EMI Purchase'}</h3>
                          <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                            <CreditCard className="h-3.5 w-3.5" />
                            {card?.name || 'Credit Card'}
                          </p>
                        </div>
                        <Badge className={
                          emi.status === 'active' 
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                            : emi.status === 'completed'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                              : 'bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400'
                        }>
                          {emi.status.toUpperCase()}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="grid grid-cols-2 gap-4 border-y py-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Total Purchase</p>
                          <p className="text-lg font-bold text-foreground">
                            {formatCurrency(emi.purchase_amount, card?.currency || 'INR')}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Monthly EMI</p>
                          <p className="text-lg font-bold text-primary">
                            {formatCurrency(emi.monthly_emi, card?.currency || 'INR')}
                          </p>
                        </div>
                      </div>

                      {/* Tenure Progress */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-medium">
                          <span>Tenure Progress</span>
                          <span className="font-mono">
                            {paidInstallments} / {emi.emi_months} Months Paid
                          </span>
                        </div>
                        <Progress value={progressPercent} className="h-2" />
                      </div>

                      <div className="space-y-2 pt-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Start Date:</span>
                          <span className="font-medium">{formatDate(emi.start_date)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Next Due Date:</span>
                          <span className="font-medium">{formatDate(emi.next_due_date)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Remaining Dues:</span>
                          <span className="font-bold text-foreground">
                            {formatCurrency(emi.remaining_installments * emi.monthly_emi, card?.currency || 'INR')}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
