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
   | cheque number | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,2,0)&"","")` |
   | bank | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,3,0)&"","")` |
   | status | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,5,0)&"","")` |

   The trailing `&""` on each formula matters: when the cell the VLOOKUP finds is empty — a
   `CONTESTED` or `ALL CANCELLED` voucher, exactly the case this file exists to flag — Excel's
   VLOOKUP returns `0`, not an error, so `IFERROR` alone would silently display a `0` instead of a
   blank cell. Appending `&""` turns that `0` into empty text before `IFERROR` ever has to act,
   so a voucher this system refused to answer shows as blank, not as a fabricated cheque number.

   **A blank cheque number is not a failure.** It means Check Release Monitoring will not guess,
   and the `STATUS` column tells you which of three reasons applies. The `REMARKS` column (10)
   spells it out in words every time.

   | status | what it means | what to do |
   | --- | --- | --- |
   | `CONTESTED` | Two live cheques both name this voucher. Naming one of them would tell a supplier the wrong thing. | Settle it in Check Release Monitoring. `REMARKS` names both cheques and their companies. |
   | `ALL CANCELLED` | Every cheque that named this voucher was cancelled or voided. There is no live cheque to give. | The payable still needs a cheque. `REMARKS` lists the cancelled ones. |
   | `NOT KEYED` | A staged row names this voucher and was never settled, so no cheque number can be given. `REMARKS` gives the specific reason (sheet, row, and whatever cheque reference was stated there) for each row that names it. | Settle it on the STAGED QUEUE page in Check Release Monitoring. `REMARKS` names the sheet and row. |

   A voucher with **no row at all** is different again, and is the normal case: it means no cheque
   has been written for that payable yet. The formula returns an empty cell.

   **A blank BANK cell beside a real cheque number is not the same kind of gap.** The `BANK`
   column is read from the cheque's checkbook, falling back to its cash account, and left blank
   only when neither is recorded — the cheque itself is not in question, just which bank issued
   it. If `CHECK NUMBER` has a value but `BANK` is empty, look the cheque number up directly in
   Check Release Monitoring rather than treating it as one of the three statuses above.

4. To show how old the file is anywhere in the workbook:
   `='[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`
