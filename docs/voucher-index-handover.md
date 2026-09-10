# CHECK BY VOUCHER.xlsx — what Finance does with it

**Before anything else: regenerate the file and confirm, in Excel, that one of the formulas
below returns a cheque number rather than a blank cell.** A formula that silently returns `""`
because the path is wrong looks identical to a formula that correctly found nothing — and that
silent failure is the exact problem this file replaces. Do this check first, on a copy of the
Executive Report, before relying on any of the numbers it shows.

1. Download it from the dashboard: **VOUCHER INDEX (ALL CHEQUES)**.
2. Save it to the agreed folder, **keeping the name exactly** `CHECK BY VOUCHER.xlsx`. The
   Executive Report finds it by that name; renaming it breaks every formula below.
3. In `Finance Executive Report`, sheet `AP Local`, the three working columns that used to look
   into `CHECK MONITORING` are replaced by one lookup each against the new file. `C` is
   `Reference Nbr.`:

   | wanted | formula |
   | --- | --- |
   | cheque number | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,2,0),"")` |
   | bank | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,3,0),"")` |
   | status | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,5,0),"")` |

   **A blank cheque number is not a failure.** It means Check Release Monitoring will not guess,
   and the `STATUS` column tells you which of three reasons applies. The `REMARKS` column (10)
   spells it out in words every time.

   | status | what it means | what to do |
   | --- | --- | --- |
   | `CONTESTED` | Two live cheques both name this voucher. Naming one of them would tell a supplier the wrong thing. | Settle it in Check Release Monitoring. `REMARKS` names both cheques and their companies. |
   | `ALL CANCELLED` | Every cheque that named this voucher was cancelled or voided. There is no live cheque to give. | The payable still needs a cheque. `REMARKS` lists the cancelled ones. |
   | `NOT KEYED` | The old register knew a cheque number for this voucher, but never said which company's cheque it was — and therefore which bank's. | Settle it on the STAGED QUEUE page in Check Release Monitoring. `REMARKS` names the sheet and row. |

   A voucher with **no row at all** is different again, and is the normal case: it means no cheque
   has been written for that payable yet. The formula returns an empty cell.

4. To show how old the file is anywhere in the workbook:
   `='[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`
